// Pure helpers for the Partners and Sponsors pages.
import type { SponsorBooking, SponsorBookingStatus } from '@swarm/domain';

export const BOOKING_STATUS_LABEL: Record<SponsorBookingStatus, string> = {
  requested: 'Waiting for you',
  accepted: 'Accepted',
  declined: 'Declined',
  canceled: 'Canceled',
};

/** A sponsor in a post: always labelled, and through the link that counts their clicks. */
export function sponsorCard(booking: Pick<SponsorBooking, 'adTitle' | 'adBody' | 'clickUrl'>) {
  return {
    href: booking.clickUrl,
    title: `Sponsored: ${booking.adTitle}`,
    description: booking.adBody,
  };
}

export const clickCount = (n: number) =>
  `${new Intl.NumberFormat('en').format(n)} ${n === 1 ? 'click' : 'clicks'}`;
