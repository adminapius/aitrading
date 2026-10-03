const configuredAlpacaUrl = process.env.ALPACA_BASE_URL?.trim().replace(/\/+$/, '')

export const tradingConfig = {
  supabaseUrl: (process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL)?.trim().replace(/\/+$/, ''),
  supabaseKey:
    (process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
      process.env.SUPABASE_SECRET_KEY?.trim() ||
      process.env.SUPABASE_PUBLISHABLE_KEY?.trim() ||
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()),
  alpacaBaseUrl: (configuredAlpacaUrl || 'https://paper-api.alpaca.markets').replace(/\/v2$/, ''),
  alpacaDataFeed: process.env.ALPACA_DATA_FEED?.trim() || 'iex',
  railwayServiceUrl: process.env.RAILWAY_SERVICE_URL?.trim().replace(/\/+$/, ''),
  mode: 'paper' as const,
} as const

export function assertServerConfig() {
  if (!tradingConfig.supabaseUrl || !tradingConfig.supabaseKey) {
    throw new Error('Supabase server configuration is missing')
  }
}

export function supabaseHeaders() {
  assertServerConfig()
  return {
    apikey: tradingConfig.supabaseKey!,
    Authorization: `Bearer ${tradingConfig.supabaseKey}`,
    'Content-Type': 'application/json',
  }
}
