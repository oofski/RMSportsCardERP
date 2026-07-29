import { renderToStaticMarkup } from 'react-dom/server'
import type { StreamDayFinance, FinancePeriodRow } from '@shared/financeStreaming'
import { FinanceCalendar } from '/home/user/RMSportsCardERP/src/renderer/src/modules/finance/FinanceCalendar'
import { PeriodList } from '/home/user/RMSportsCardERP/src/renderer/src/modules/finance/PeriodList'
import { DayStatement } from '/home/user/RMSportsCardERP/src/renderer/src/modules/finance/Statement'

const day = (streamDate: string, over: Partial<StreamDayFinance> = {}): StreamDayFinance => ({
  streamDate, sessionCount: 2, sessionTitles: ['Monster Break Night', 'Late Rip'], minutes: 254,
  sales: 12840.55, saleCount: 1029, tips: 40, bonuses: 0, totalRevenue: 12880.55,
  whatnotFee: -770.43, processingFee: -681.07, totalFees: -1451.5, netRevenue: 11429.05,
  shippingSubsidy: 310.5, shippingCharges: -412.2, giveawayShipping: -18.4, refundShipping: 0,
  netShipping: -120.1, showBoost: -50, reversals: -212.4, giveawayLoss: -180,
  netAfterCosts: 10866.55, breakCost: -8200, giveawayCost: -180, cogs: -8380,
  grossProfit: 4500.55, netProfit: 2666.55, rowCount: 1204, carriedBackRows: 88,
  carriedBackAmount: -140.2, ...over
})

const days = [
  day('2026-07-03'),
  day('2026-07-10', { netProfit: -812.4, totalRevenue: 2200, sessionCount: 1 }),
  day('2026-07-24', { netProfit: 0 }),
  day('2026-07-25', { netProfit: 12845.1 })
]

const week: FinancePeriodRow = { ...day('2026-07-20'), key: '2026-W30', label: 'Week of Jul 20', from: '2026-07-20', to: '2026-07-26', dayCount: 5 } as unknown as FinancePeriodRow

const html =
  renderToStaticMarkup(<FinanceCalendar days={days} />) +
  '\n<!--PERIODS-->\n' +
  renderToStaticMarkup(<PeriodList rows={[week]} period="week" />) +
  '\n<!--STATEMENT-->\n' +
  renderToStaticMarkup(<DayStatement day={days[0]} onClose={() => {}} />) +
  '\n<!--BROKEN-CHECKSUM-->\n' +
  renderToStaticMarkup(<DayStatement day={day('2026-07-31', { netProfit: 99 })} onClose={() => {}} />)
// eslint-disable-next-line no-console
console.log(html)
