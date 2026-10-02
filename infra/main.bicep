targetScope = 'resourceGroup'

@description('Azure region approved for this environment. External AI services need separate regional validation.')
param location string = resourceGroup().location

@minLength(3)
@maxLength(12)
@description('Lowercase letters and digits only; globally unique suffixes are added automatically.')
param namePrefix string = 'cardemo'

@description('Foundation-only by default. Enable only after placing the signing secret in Key Vault.')
param deployApi bool = false

@description('Immutable ACR image reference, preferably a digest. Required when deployApi is true.')
param apiImage string = ''

@description('Comma-separated exact browser origins, without paths or trailing slash. No wildcards.')
param allowedOrigins string = 'https://example.invalid'

@description('Versioned or versionless HTTPS URI of TOKEN_SIGNING_SECRET in this deployment’s Key Vault. Never a secret value.')
param authSecretUri string = ''

@description('Optional Key Vault reference for WEB_IQ_API_KEY. A key alone does not enable Web IQ.')
param webIqApiKeySecretUri string = ''

@description('Official approved Web IQ endpoint. Leave empty until endpoint and API contract are verified.')
param webIqEndpoint string = ''

@description('Optional Web IQ authentication header name, not its value.')
param webIqAuthHeader string = ''

@description('Leave empty unless the Web IQ JSON search contract has been verified (verified-json-search-v1).')
param webIqContract string = ''

@description('HTTPS evidence URL for the verified Web IQ contract.')
param webIqVerificationUrl string = ''

@description('Verified positive Web IQ USD price per request, as a decimal string; empty disables pricing.')
param webIqRequestUsd string = ''

@description('Optional Azure Responses resource root for Web IQ search, with an attested gpt-6.1-sol deployment.')
param webIqResponsesEndpoint string = ''
param webIqResponsesDeployment string = ''
param webIqResponsesKeySecretUri string = ''
@description('JSON array of operator-reviewed read-only MCP tool names from authenticated Web IQ discovery.')
param webIqReadonlyToolsJson string = ''
param webIqSearchVerified bool = false
@description('Non-secret verified Web IQ MCP-call and Responses token prices with reservation and output limits.')
param webIqSearchRateCardJson string = ''

@description('Optional HTTPS Voice Live service endpoint; empty leaves the provider unconfigured.')
param voiceLiveEndpoint string = ''

@description('Voice Live deployment region; must match the verified rate card.')
param voiceLiveRegion string = ''

@description('Use the existing API managed identity for Voice Live. Does not grant any additional permissions.')
param voiceLiveUseManagedIdentity bool = false

@description('Attest target-resource WebRTC signaling, usage, tools and disconnect verification; false by default.')
param voiceLiveWebRtcVerified bool = false

@description('Non-secret VOICE_RATE_CARD_JSON text with verified pricing/evidence. Empty disables pricing; loadConfig validates schema and ranges.')
param voiceRateCardJson string = ''

@description('Optional HTTPS Key Vault secret URI for VOICE_LIVE_API_KEY in this deployment vault. Never a key value.')
param voiceLiveApiKeySecretUri string = ''

@description('Optional GPT-Live Azure OpenAI HTTPS resource root; uses the existing managed identity without new role assignments.')
param gptLiveEndpoint string = ''

@description('Operator-verified gpt-live-1 deployment name.')
param gptLiveDeployment string = ''

@description('GPT-Live deployment region.')
param gptLiveRegion string = ''

@description('Attest GPT-Live deployment and protocol verification; false leaves the provider disabled.')
param gptLiveDeploymentVerified bool = false

@description('Non-secret GPT_LIVE_RATE_CARD_JSON text with verified hourly pricing/evidence. loadConfig validates schema, ranges and full-session reservation.')
param gptLiveRateCardJson string = ''
param gptLiveResponsesDelegationVerified bool = false
param gptLiveResponsesRateCardJson string = ''

@description('Optional Azure Speech region for the explicit Speech/Responses/Speech cascade.')
param cascadeSpeechRegion string = ''

@description('Optional HTTPS Key Vault secret URI for CASCADE_SPEECH_KEY in this deployment vault. Never a key value.')
param cascadeSpeechKeySecretUri string = ''

@description('Optional cascade Azure OpenAI HTTPS resource root, not a chat-completions URL.')
param cascadeResponsesEndpoint string = ''

@description('Optional HTTPS Key Vault secret URI for CASCADE_RESPONSES_KEY in this deployment vault. Never a key value.')
param cascadeResponsesKeySecretUri string = ''

@description('Operator-verified gpt-6.1-sol Responses deployment name for the cascade.')
param cascadeDeployment string = ''

@description('Attest cascade Speech and Responses deployments; false leaves the provider disabled.')
param cascadeDeploymentVerified bool = false

@description('Non-secret CASCADE_RATE_CARD_JSON text with verified text/STT/TTS pricing/evidence. loadConfig validates schema and ranges.')
param cascadeRateCardJson string = ''

@description('Optional HTTPS Key Vault secret URI for AZURE_MAPS_KEY in this deployment vault. Never a key value.')
param azureMapsKeySecretUri string = ''

@description('Verified positive Azure Maps USD price per request, as a decimal string; empty disables Maps.')
param azureMapsRequestUsd string = ''

param adminTenantId string = ''
param adminAudience string = ''
param adminClientId string = ''
param adminScope string = ''
param adminRole string = 'Lead.Admin'

@description('Optional subscription/resource-group ARM scope for provisional Cost Management queries. Grant the API identity Cost Management Reader separately at this scope.')
param azureCostScope string = ''

param cosmosDatabaseName string = 'car-demo'
param cosmosContainerName string = 'records'

var suffix = uniqueString(resourceGroup().id, namePrefix)
var resourceName = '${namePrefix}-${suffix}'

resource identity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${resourceName}-api'
  location: location
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: '${namePrefix}${suffix}'
  location: location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, identity.id, 'AcrPull')
  scope: registry
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
  }
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: '${take(namePrefix, 10)}-${suffix}'
  location: location
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enablePurgeProtection: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
    accessPolicies: []
    networkAcls: {
      bypass: 'AzureServices'
      defaultAction: 'Allow'
    }
  }
}

// This vault is dedicated to the API; the identity has no vault write permission.
resource secretsReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(vault.id, identity.id, 'KeyVaultSecretsUser')
  scope: vault
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '4633458b-17de-408a-b874-0445c86b69e6')
  }
}

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: resourceName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    disableLocalAuth: true
    publicNetworkAccess: 'Enabled'
    minimalTlsVersion: 'Tls12'
    capabilities: [{ name: 'EnableServerless' }]
    consistencyPolicy: { defaultConsistencyLevel: 'Session' }
    locations: [
      { locationName: location, failoverPriority: 0, isZoneRedundant: false }
    ]
    backupPolicy: {
      type: 'Periodic'
      periodicModeProperties: {
        backupIntervalInMinutes: 240
        backupRetentionIntervalInHours: 8
        backupStorageRedundancy: 'Local'
      }
    }
  }
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: cosmos
  name: cosmosDatabaseName
  properties: { resource: { id: cosmosDatabaseName } }
}

// The adapter stores leads and daily ledgers together, partitioned by /id.
// A lead explicitly carries ttl=7776000; the safe default is 30 days.
resource records 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: database
  name: cosmosContainerName
  properties: {
    resource: {
      id: cosmosContainerName
      partitionKey: { paths: ['/id'], kind: 'Hash', version: 2 }
      defaultTtl: 2592000
      indexingPolicy: { indexingMode: 'consistent', automatic: true }
    }
  }
}

resource cosmosDataAccess 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmos
  name: guid(cosmos.id, identity.id, database.name)
  properties: {
    principalId: identity.properties.principalId
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    scope: '${cosmos.id}/dbs/${cosmosDatabaseName}'
  }
}

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${resourceName}-logs'
  location: location
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
    workspaceCapping: { dailyQuotaGb: json('0.1') }
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${resourceName}-insights'
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
    RetentionInDays: 30
    IngestionMode: 'LogAnalytics'
    DisableLocalAuth: true
  }
}

resource telemetrySender 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(insights.id, identity.id, 'MonitoringMetricsPublisher')
  scope: insights
  properties: {
    principalId: identity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '3913510d-42f4-4e42-8a64-420c390055eb')
  }
}

resource environment 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${resourceName}-env'
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}

module api './modules/api.bicep' = if (deployApi) {
  name: '${namePrefix}-api'
  params: {
    location: location
    name: '${resourceName}-api'
    environmentId: environment.id
    identityId: identity.id
    clientId: identity.properties.clientId
    registryServer: registry.properties.loginServer
    image: apiImage
    allowedOrigins: allowedOrigins
    authSecretUri: authSecretUri
    webIqApiKeySecretUri: webIqApiKeySecretUri
    webIqEndpoint: webIqEndpoint
    webIqAuthHeader: webIqAuthHeader
    webIqContract: webIqContract
    webIqVerificationUrl: webIqVerificationUrl
    webIqRequestUsd: webIqRequestUsd
    webIqResponsesEndpoint: webIqResponsesEndpoint
    webIqResponsesDeployment: webIqResponsesDeployment
    webIqResponsesKeySecretUri: webIqResponsesKeySecretUri
    webIqReadonlyToolsJson: webIqReadonlyToolsJson
    webIqSearchVerified: webIqSearchVerified
    webIqSearchRateCardJson: webIqSearchRateCardJson
    voiceLiveEndpoint: voiceLiveEndpoint
    voiceLiveRegion: voiceLiveRegion
    voiceLiveUseManagedIdentity: voiceLiveUseManagedIdentity
    voiceLiveWebRtcVerified: voiceLiveWebRtcVerified
    voiceRateCardJson: voiceRateCardJson
    voiceLiveApiKeySecretUri: voiceLiveApiKeySecretUri
    gptLiveEndpoint: gptLiveEndpoint
    gptLiveDeployment: gptLiveDeployment
    gptLiveRegion: gptLiveRegion
    gptLiveDeploymentVerified: gptLiveDeploymentVerified
    gptLiveRateCardJson: gptLiveRateCardJson
    gptLiveResponsesDelegationVerified: gptLiveResponsesDelegationVerified
    gptLiveResponsesRateCardJson: gptLiveResponsesRateCardJson
    cascadeSpeechRegion: cascadeSpeechRegion
    cascadeSpeechKeySecretUri: cascadeSpeechKeySecretUri
    cascadeResponsesEndpoint: cascadeResponsesEndpoint
    cascadeResponsesKeySecretUri: cascadeResponsesKeySecretUri
    cascadeDeployment: cascadeDeployment
    cascadeDeploymentVerified: cascadeDeploymentVerified
    cascadeRateCardJson: cascadeRateCardJson
    azureMapsKeySecretUri: azureMapsKeySecretUri
    azureMapsRequestUsd: azureMapsRequestUsd
    adminTenantId: adminTenantId
    adminAudience: adminAudience
    adminClientId: adminClientId
    adminScope: adminScope
    adminRole: adminRole
    azureCostScope: azureCostScope
    cosmosEndpoint: cosmos.properties.documentEndpoint
    cosmosDatabaseName: cosmosDatabaseName
    cosmosContainerName: cosmosContainerName
    insightsConnectionString: insights.properties.ConnectionString
  }
  dependsOn: [acrPull, secretsReader, cosmosDataAccess, telemetrySender, records]
}

output registryName string = registry.name
output registryServer string = registry.properties.loginServer
output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri
output identityClientId string = identity.properties.clientId
output identityPrincipalId string = identity.properties.principalId
output cosmosEndpoint string = cosmos.properties.documentEndpoint
output apiUrl string = deployApi ? api!.outputs.url : ''
