type PaperExitPosition = {
  entry_price: number | string
  stop_price?: number | string | null
  target_price?: number | string | null
  metadata?: Record<string, unknown> | null
}

type PaperExitMark = {
  price: number
  bid: number
}

function numeric(value: unknown) {
  if (value == null) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

export function paperExitLevels(position: PaperExitPosition) {
  const entryPrice = numeric(position.entry_price)
  const riskPerShare = numeric(position.metadata?.riskPerShare) ?? (entryPrice == null ? null : entryPrice * 0.02)
  return {
    stopPrice: numeric(position.stop_price) ?? (entryPrice != null && riskPerShare != null ? entryPrice - riskPerShare : null),
    targetPrice: numeric(position.target_price) ?? (entryPrice != null && riskPerShare != null ? entryPrice + riskPerShare * 1.5 : null),
    riskPerShare,
  }
}

export function paperExitReason(position: PaperExitPosition, mark: PaperExitMark, flatten: boolean) {
  if (flatten) return 'scheduled session flatten'
  if (numeric(position.entry_price) == null) return null
  const { stopPrice, targetPrice } = paperExitLevels(position)
  if (stopPrice != null && mark.price <= stopPrice) return 'protective stop reached'
  if (targetPrice != null && mark.price >= targetPrice) return 'profit target reached'
  return null
}

export function paperExitRequestedPrice(position: PaperExitPosition, mark: PaperExitMark, exitReason: string) {
  const { stopPrice, targetPrice } = paperExitLevels(position)
  if (exitReason === 'protective stop reached' && stopPrice != null) return stopPrice
  if (exitReason === 'profit target reached' && targetPrice != null) return targetPrice
  return mark.bid
}
