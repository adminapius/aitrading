function normalizeUrl(value: string | undefined) {
  const trimmed = value?.trim().replace(/\/+$/, '')
  return trimmed ? (/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`) : undefined
}

const configuredAlpacaUrl = normalizeUrl(process.env.ALPACA_BASE_URL)
const configuredAlpacaDataUrl = normalizeUrl(process.env.ALPACA_DATA_URL)
const alpacaApiSecret = process.env.ALPACA_API_SECRET?.trim() || process.env.ALPACA_SECRET?.trim()
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()

// Supabase service-role JWTs carry their project ref, which can recover a missing URL in preview environments.
function inferSupabaseUrlFromKey(key: string | undefined) {
  const payload = key?.split('.')[1]
  if (!payload) return undefined

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { ref?: unknown }
    if (typeof claims.ref !== 'string' || !/^[a-z0-9-]{10,50}$/.test(claims.ref)) return undefined
    return `https://${claims.ref}.supabase.co`
  } catch {
    return undefined
  }
}

const configuredSupabaseUrl =
  process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
  process.env.SUPABASE_URL?.trim() ||
  inferSupabaseUrlFromKey(supabaseKey)

export const tradingConfig = {
  supabaseUrl: normalizeUrl(configuredSupabaseUrl),
  supabaseKey,
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
    alpaca: Boolean(process.env.ALPACA_API_KEY?.trim() && alpacaApiSecret),
    marketData: Boolean(process.env.ALPACA_API_KEY?.trim() && alpacaApiSecret),
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
    'APCA-API-SECRET-KEY': alpacaApiSecret ?? '',
  }
}

export function getSupabaseConfigurationError() {
  if (!tradingConfig.supabaseUrl) return 'Supabase URL is not configured in the server environment'
  if (!tradingConfig.supabaseKey) return 'SUPABASE_SERVICE_ROLE_KEY is not configured in the server environment'
  return null
}

export function assertServerConfig() {
  const error = getSupabaseConfigurationError()
  if (error) throw new Error(error)
}

export function supabaseHeaders() {
  assertServerConfig()
  return {
    apikey: tradingConfig.supabaseKey!,
    Authorization: `Bearer ${tradingConfig.supabaseKey}`,
    'Content-Type': 'application/json',
  }
}
