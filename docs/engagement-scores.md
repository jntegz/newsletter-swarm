# Engagement scores

The engagement score (flag `engagement_scores`, on at install, and the publication's **Reader profiles** switch) gives each active or paused subscriber a score from 0 to 100, worked out once a day. Code: `packages/engine/src/engagement.ts`, `member_engagement` (`migrations/0044_engagement_scores.sql`). Dashboard: the Engagement column on Subscribers, the subscriber's drawer, and the Engagement group in segment conditions. API: `engagement` on each Member and `GET /v2/channels/{channelId}/members/engagement` (`members:read`), so agents get the same numbers.

## How it is worked out

It looks at posts that reached the person in the last 90 days with an open pixel. Posts sent in the last day are left out, because nobody has had time to read them, and failed or bounced ones are left out because they never arrived.

| Part                 | Points | Measure                                                 |
| -------------------- | ------ | ------------------------------------------------------- |
| When they last read  | 40     | Full marks today, falling to none at 90 days            |
| How often they open  | 35     | Opens by a person, of the posts where opens can be seen |
| How often they click | 25     | Full marks at a click on one post in four               |

| Level             | Meaning                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Very engaged      | 60 or more                                                                                       |
| Engaged           | 30 to 59                                                                                         |
| Slipping          | 10 to 29                                                                                         |
| Cold              | Under 10                                                                                         |
| Too few posts yet | Fewer than 3 posts reached them in the window. No score.                                         |
| Opens hidden      | At least half their posts were opened by a machine, with no open or click by a person. No score. |

**Opens hidden** matters most. Apple Mail and similar services open every message, so those people can't be told apart from keen readers or absent ones. They aren't called cold, so a segment like "Engagement level is Cold" won't drop them. If they click, they get a normal score, and posts opened only by a machine aren't held against them.

## In segments

A condition can test the score or the level, in segments, Smart Blocks and automation filters. Someone with no score matches no positive test: "score under 20" leaves them out, and "level is not Cold" includes them.

A score counts for 7 days. If the daily pass stops, conditions stop matching rather than steering sends from old numbers. A segment that includes "Very engaged" would then reach nobody, which the send checks show before anything goes out.

## Privacy

The score uses only the opens and clicks Swarm already records, and nothing leaves the install. It appears in a subscriber's data export and is deleted with them. Turning the flag off deletes all scores for that publication at the next daily pass, and they return the day after it is turned back on.

Scores are a kind of reader profile, so they follow the tracking choices ([Tracking and retention](privacy-controls.md)):

- A publication with **Reader profiles** or **Open tracking** off under **Sending & delivery > Tracking** keeps no scores, as if the flag were off for it. The flag can only switch scores off for everyone; the publication switch narrows it further.
- Someone who ticked **Don't track my opens and clicks** in their subscriber settings gets no score, their stored score is deleted at once, and they never count as inactive.
- Emails sent without an open pixel (open tracking off for that send, or the person had asked) don't count toward "posts that reached them", so a stretch with tracking off makes nobody look cold.

## With the flag off

The column, drawer panel and conditions are hidden, `engagement` is null, the summary answers 404 `feature_disabled`, and a new segment rule using the score is refused. An existing segment with such a rule stops matching on the score once the scores expire or are deleted.
