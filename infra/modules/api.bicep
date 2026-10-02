param location string
param name string
param environmentId string
param identityId string
param clientId string
param registryServer string
@minLength(1)
param image string
param allowedOrigins string
@minLength(1)
param authSecretUri string
param webIqApiKeySecretUri string = ''
param webIqEndpoint string = ''
param webIqAuthHeader string = ''
param webIqContract string = ''
param webIqVerificationUrl string = ''
param webIqRequestUsd string = ''
param webIqResponsesEndpoint string = ''
param webIqResponsesDeployment string = ''
param webIqResponsesKeySecretUri string = ''
param webIqReadonlyToolsJson string = ''
param webIqSearchVerified bool = false
param webIqSearchRateCardJson string = ''
param voiceLiveEndpoint string = ''
param voiceLiveRegion string = ''
param voiceLiveUseManagedIdentity bool = false
param voiceLiveWebRtcVerified bool = false
param voiceRateCardJson string = ''
param voiceLiveApiKeySecretUri string = ''
param gptLiveEndpoint string = ''
param gptLiveDeployment string = ''
param gptLiveRegion string = ''
param gptLiveDeploymentVerified bool = false
param gptLiveRateCardJson string = ''
param gptLiveResponsesDelegationVerified bool = false
param gptLiveResponsesRateCardJson string = ''
param cascadeSpeechRegion string = ''
param cascadeSpeechKeySecretUri string = ''
param cascadeResponsesEndpoint string = ''
param cascadeResponsesKeySecretUri string = ''
param cascadeDeployment string = ''
param cascadeDeploymentVerified bool = false
param cascadeRateCardJson string = ''
param azureMapsKeySecretUri string = ''
param azureMapsRequestUsd string = ''
param adminTenantId string = ''
param adminAudience string = ''
param adminClientId string = ''
param adminScope string = ''
param adminRole string = 'Lead.Admin'
param azureCostScope string = ''
param cosmosEndpoint string
param cosmosDatabaseName string
param cosmosContainerName string
@secure()
param insightsConnectionString string

var providerSecrets = [
  { name: 'web-iq-api-key', envName: 'WEB_IQ_API_KEY', uri: webIqApiKeySecretUri }
  { name: 'web-iq-responses-key', envName: 'WEB_IQ_RESPONSES_KEY', uri: webIqResponsesKeySecretUri }
  { name: 'voice-live-api-key', envName: 'VOICE_LIVE_API_KEY', uri: voiceLiveApiKeySecretUri }
  { name: 'cascade-speech-key', envName: 'CASCADE_SPEECH_KEY', uri: cascadeSpeechKeySecretUri }
  { name: 'cascade-responses-key', envName: 'CASCADE_RESPONSES_KEY', uri: cascadeResponsesKeySecretUri }
  { name: 'azure-maps-key', envName: 'AZURE_MAPS_KEY', uri: azureMapsKeySecretUri }
]
var configuredProviderSecrets = filter(providerSecrets, secret => !empty(secret.uri))

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${identityId}': {} }
  }
  properties: {
    managedEnvironmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3001
        transport: 'auto'
        allowInsecure: false
        traffic: [{ latestRevision: true, weight: 100 }]
      }
      registries: [{ server: registryServer, identity: identityId }]
      secrets: concat([
        { name: 'auth-secret', keyVaultUrl: authSecretUri, identity: identityId }
      ], map(configuredProviderSecrets, secret => {
        name: secret.name
        keyVaultUrl: secret.uri
        identity: identityId
      }))
    }
    template: {
      containers: [
        {
          name: 'api'
          image: image
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: concat([
            { name: 'NODE_ENV', value: 'production' }
            { name: 'HOST', value: '0.0.0.0' }
            { name: 'PORT', value: '3001' }
            { name: 'ALLOWED_ORIGINS', value: allowedOrigins }
            { name: 'TOKEN_SIGNING_SECRET', secretRef: 'auth-secret' }
            { name: 'AZURE_CLIENT_ID', value: clientId }
            { name: 'COSMOS_ENDPOINT', value: cosmosEndpoint }
            { name: 'PERSISTENCE_MODE', value: 'cosmos' }
            { name: 'COSMOS_DATABASE', value: cosmosDatabaseName }
            { name: 'COSMOS_CONTAINER', value: cosmosContainerName }
            { name: 'MAX_REPLICAS', value: '1' }
            { name: 'MAX_CONCURRENT_SESSIONS', value: '1' }
            { name: 'ADMIN_TENANT_ID', value: adminTenantId }
            { name: 'ADMIN_AUDIENCE', value: adminAudience }
            { name: 'ADMIN_CLIENT_ID', value: adminClientId }
            { name: 'ADMIN_SCOPE', value: adminScope }
            { name: 'ADMIN_ROLE', value: adminRole }
            { name: 'AZURE_COST_SCOPE', value: azureCostScope }
            { name: 'WEB_IQ_ENDPOINT', value: webIqEndpoint }
            { name: 'WEB_IQ_AUTH_HEADER', value: webIqAuthHeader }
            { name: 'WEB_IQ_CONTRACT', value: webIqContract }
            { name: 'WEB_IQ_VERIFICATION_URL', value: webIqVerificationUrl }
            { name: 'WEB_IQ_REQUEST_USD', value: webIqRequestUsd }
            { name: 'WEB_IQ_RESPONSES_ENDPOINT', value: webIqResponsesEndpoint }
            { name: 'WEB_IQ_RESPONSES_DEPLOYMENT', value: webIqResponsesDeployment }
            { name: 'WEB_IQ_READONLY_TOOLS_JSON', value: webIqReadonlyToolsJson }
            { name: 'WEB_IQ_SEARCH_VERIFIED', value: string(webIqSearchVerified) }
            { name: 'WEB_IQ_SEARCH_RATE_CARD_JSON', value: webIqSearchRateCardJson }
            { name: 'VOICE_LIVE_ENDPOINT', value: voiceLiveEndpoint }
            { name: 'VOICE_LIVE_REGION', value: voiceLiveRegion }
            { name: 'VOICE_LIVE_USE_MANAGED_IDENTITY', value: string(voiceLiveUseManagedIdentity) }
            { name: 'VOICE_LIVE_WEBRTC_VERIFIED', value: string(voiceLiveWebRtcVerified) }
            { name: 'VOICE_RATE_CARD_JSON', value: voiceRateCardJson }
            { name: 'GPT_LIVE_ENDPOINT', value: gptLiveEndpoint }
            { name: 'GPT_LIVE_DEPLOYMENT', value: gptLiveDeployment }
            { name: 'GPT_LIVE_REGION', value: gptLiveRegion }
            { name: 'GPT_LIVE_DEPLOYMENT_VERIFIED', value: string(gptLiveDeploymentVerified) }
            { name: 'GPT_LIVE_RATE_CARD_JSON', value: gptLiveRateCardJson }
            { name: 'GPT_LIVE_RESPONSES_DELEGATION_VERIFIED', value: string(gptLiveResponsesDelegationVerified) }
            { name: 'GPT_LIVE_RESPONSES_RATE_CARD_JSON', value: gptLiveResponsesRateCardJson }
            { name: 'CASCADE_SPEECH_REGION', value: cascadeSpeechRegion }
            { name: 'CASCADE_RESPONSES_ENDPOINT', value: cascadeResponsesEndpoint }
            { name: 'CASCADE_DEPLOYMENT', value: cascadeDeployment }
            { name: 'CASCADE_DEPLOYMENT_VERIFIED', value: string(cascadeDeploymentVerified) }
            { name: 'CASCADE_RATE_CARD_JSON', value: cascadeRateCardJson }
            { name: 'AZURE_MAPS_REQUEST_USD', value: azureMapsRequestUsd }
            { name: 'APPLICATIONINSIGHTS_CONNECTION_STRING', value: insightsConnectionString }
            { name: 'APPLICATIONINSIGHTS_AUTHENTICATION_STRING', value: 'ClientId=${clientId};Authorization=AAD' }
          ], map(configuredProviderSecrets, secret => {
            name: secret.envName
            secretRef: secret.name
          }))
          probes: [
            {
              type: 'Startup'
              httpGet: { path: '/api/health', port: 3001, scheme: 'HTTP' }
              initialDelaySeconds: 5
              periodSeconds: 5
              failureThreshold: 30
            }
            {
              type: 'Liveness'
              httpGet: { path: '/api/health', port: 3001, scheme: 'HTTP' }
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/api/health', port: 3001, scheme: 'HTTP' }
              periodSeconds: 10
              failureThreshold: 3
            }
          ]
        }
      ]
      // Never scale volatile mock sessions/budgets horizontally.
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

output url string = 'https://${app.properties.configuration.ingress.fqdn}'
