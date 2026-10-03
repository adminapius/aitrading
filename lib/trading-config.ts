function normalizeUrl(value: string | undefined) {
  const trimmed = value?.trim().replace(/\/+$/, '')
  return trimmed ? (/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`) : undefined
}

const configuredAlpacaUrl = normalizeUrl(process.env.ALPACA_BASE_URL)
const configuredAlpacaDataUrl = normalizeUrl(process.env.ALPACA_DATA_URL)

export const tradingConfig = {
  supabaseUrl: (process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL)?.trim().replace(/\/+$/, ''),
  supabaseKey:
    (process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ||
      process.env.SUPABASE_SECRET_KEY?.trim() ||
      process.env.SUPABASE_PUBLISHABLE_KEY?.trim() ||
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim()),
  alpacaBaseUrl: (configuredAlpacaUrl || 'https://paper-api.alpaca.markets').replace(/\/v2$/, ''),
  alpacaDataUrl: (configuredAlpacaDataUrl || 'https://data.alpaca.markets').replace(/\/v2$/, ''),
  alpacaDataFeed: process.env.ALPACA_DATA_FEED?.trim() || 'iex',
  railwayServiceUrl: process.env.RAILWAY_SERVICE_URL?.trim().replace(/\/+$/, ''),
  mode: 'paper' as const,
  liveTradingEnabled: false as const,
} as const

export function configuredServices() {
  return {
    supabase: Boolean(tradingConfig.supabaseUrl && tradingConfig.supabaseKey),
    alpaca: Boolean(process.env.ALPACA_API_KEY?.trim() && process.env.ALPACA_API_SECRET?.trim()),
    marketData: Boolean(process.env.ALPACA_API_KEY?.trim() && process.env.ALPACA_API_SECRET?.trim()),
    railway: Boolean(tradingConfig.railwayServiceUrl),
    telegram: Boolean(process.env.TELEGRAM_BOT_TOKEN?.trim() && process.env.TELEGRAM_CHAT_ID?.trim()),
    ntfy: Boolean(process.env.NTFY_TOPIC_URL?.trim()),
    aiPrimary: Boolean(process.env.GEMINI_API_KEY?.trim()),
    aiFallback: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
  }
}

export function alpacaHeaders() {
  return {
    'APCA-API-KEY-ID': process.env.ALPACA_API_KEY ?? '',
    'APCA-API-SECRET-KEY': process.env.ALPACA_API_SECRET ?? '',
  }
}

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
