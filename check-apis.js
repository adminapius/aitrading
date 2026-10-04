const checks = {}

async function check(name, url, options = {}) {
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(8000) })
    checks[name] = { status: response.status, ok: response.ok }
  } catch (error) {
    checks[name] = { ok: false, error: error instanceof Error ? error.message : 'Request failed' }
  }
}

async function checkAPIs() {
  await check(
    'Benzinga',
    'https://api.benzinga.com/api/v2/news?token=' + encodeURIComponent(process.env.BENZINGA_API_KEY ?? '') + '&pagesize=1',
    { headers: { accept: 'application/json' } },
  )
  await check(
    'Stocktwits',
    'https://api.stocktwits.com/api/2/streams/symbol/AAPL.json',
    { headers: { Authorization: `Bearer ${process.env.STOCKTWITS_API_KEY ?? ''}`, accept: 'application/json' } },
  )
  await check(
    'FMP',
    'https://financialmodelingprep.com/api/v3/quote/AAPL?apikey=' + encodeURIComponent(process.env.FMP_API_KEY ?? ''),
    { headers: { accept: 'application/json' } },
  )
  console.log(JSON.stringify(checks, null, 2))
}

checkAPIs()
