import { APP_NAME, COMPANY_NAME } from '@shared/config'

/** The RM Operations App wordmark: a navy/gold "RM" mark with the app name. */
export function Brand({
  onNavy = false,
  gold = false
}: {
  onNavy?: boolean
  gold?: boolean
}): JSX.Element {
  return (
    <div className="brand">
      <div className={`brand-mark ${gold ? 'gold' : ''}`}>RM</div>
      <div className="brand-text">
        <span className={`name ${onNavy ? 'on-navy' : ''}`}>{APP_NAME}</span>
        <span className={`co ${onNavy ? 'on-navy' : ''}`}>{COMPANY_NAME}</span>
      </div>
    </div>
  )
}
