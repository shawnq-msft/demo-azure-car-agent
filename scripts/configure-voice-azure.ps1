param(
    [Parameter(Mandatory = $true)][string]$SubscriptionId,
    [Parameter(Mandatory = $true)][string]$ResourceGroup,
    [Parameter(Mandatory = $true)][string]$ResourceName,
    [Parameter(Mandatory = $true)][string]$ExpectedUser
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root 'apps\api\.env'
& git -C $root check-ignore --quiet -- $envFile
if ($LASTEXITCODE -ne 0) { throw 'The backend .env must be ignored by Git before storing a key.' }
$accountJson = & az account show --subscription $SubscriptionId --output json --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'Azure account verification failed.' }
$account = $accountJson | ConvertFrom-Json
if ($account.user.name -ine $ExpectedUser) {
    throw 'The selected subscription is not authenticated with the requested account. No key was retrieved.'
}

$resourceJson = & az cognitiveservices account show --subscription $SubscriptionId --resource-group $ResourceGroup --name $ResourceName --output json --only-show-errors
if ($LASTEXITCODE -ne 0) { throw 'Unable to read the selected Azure AI resource.' }
$resource = $resourceJson | ConvertFrom-Json
if ($resource.kind -notin @('AIServices', 'CognitiveServices', 'SpeechServices')) {
    throw 'This is not a supported Azure AI / Speech resource. No key was retrieved.'
}
$endpoint = [string]$resource.properties.endpoint
if ([string]::IsNullOrWhiteSpace($endpoint) -or $endpoint -match '[\r\n"]' -or ([uri]$endpoint).Scheme -ne 'https') {
    throw 'The resource does not expose a valid HTTPS endpoint.'
}

# Capture CLI output in memory; do not print, transcript, or pass the key as a process argument.
$key = (& az cognitiveservices account keys list --subscription $SubscriptionId --resource-group $ResourceGroup --name $ResourceName --query key1 --output tsv --only-show-errors) -join ''
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($key)) {
    throw 'Key retrieval failed. Local key authentication may be disabled; use managed identity instead.'
}
if ($key -match '[\r\n"]') { throw 'Unexpected credential format; local configuration was not changed.' }
$lines = if (Test-Path $envFile) { [System.IO.File]::ReadAllLines($envFile) } else { @() }
$updates = [ordered]@{
    VOICE_LIVE_ENDPOINT = $endpoint
    VOICE_LIVE_REGION = [string]$resource.location
    VOICE_LIVE_API_KEY = $key
}
$output = [System.Collections.Generic.List[string]]::new()
foreach ($line in $lines) {
    if ($line -notmatch '^\s*(?:export\s+)?(VOICE_LIVE_ENDPOINT|VOICE_LIVE_REGION|VOICE_LIVE_API_KEY)\s*=') { $output.Add($line) }
}
foreach ($name in $updates.Keys) { $output.Add("$name=`"$($updates[$name])`"") }
$tempFile = Join-Path (Split-Path -Parent $envFile) ('.env.' + [guid]::NewGuid().ToString('N') + '.tmp')
try {
    [System.IO.File]::WriteAllLines($tempFile, $output, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $tempFile -Destination $envFile -Force
} finally {
    if (Test-Path $tempFile) { Remove-Item -LiteralPath $tempFile -Force }
    $key = $null
    $updates.Clear()
    $output.Clear()
}
Write-Output 'Voice Live endpoint, region and key saved to the ignored backend .env. No key was displayed.'
Write-Output 'A verified rate card and live model validation are still required. This does not configure Web IQ.'
