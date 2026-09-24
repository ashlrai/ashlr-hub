/**
 * routes/verse/health — seat account health UI (V3.10, unit A2).
 *
 * Mount points (owned by other units):
 *   - `ComposerSeatBlock` above the Composer's text box (unit A6).
 *   - `SeatHealthBanner` at the top of the chat workspace / Command home.
 */
export { ComposerSeatBlock, ComposerSeatBlockView } from './ComposerSeatBlock.js';
export type { ComposerSeatBlockProps, ComposerSeatBlockViewProps } from './ComposerSeatBlock.js';
export { SeatHealthBanner, SeatHealthBannerView } from './SeatHealthBanner.js';
export type { SeatHealthBannerProps, SeatHealthBannerViewProps } from './SeatHealthBanner.js';
export { reconnectSeat, refreshSeatHealth, verseHealthQuery, VERSE_HEALTH_KEY } from './health-queries.js';
export { useSeatHealth, HEALTH_POLL_MS } from './useSeatHealth.js';
export { seatHealthIssues, CONNECTION_WORD, CONNECTION_TONE } from './health-model.js';
