export const tradingConfig = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL,
  supabaseKey:
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    process.env.SUPABASE_SECRET_KEY ??
    process.env.SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  alpacaBaseUrl: process.env.ALPACA_BASE_URL ?? 'https://paper-api.alpaca.markets',
  alpacaDataFeed: process.env.ALPACA_DATA_FEED ?? 'iex',
  railwayServiceUrl: process.env.RAILWAY_SERVICE_URL,
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
