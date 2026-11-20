# Applications

Applications (flag `applications`) connect other products to a workspace, from their card on the Apps page (`/apps`). The Apps item shows while this flag, `app_directory` or `email_verification` is on. Shorthop is the first. The DeBounce card (email checks, flag `email_verification`) sits next to it but works differently: its key belongs to the whole install and is set with `pnpm swarm enable debounce`, see [email-verification.md](email-verification.md). Code: `workers/api/src/routes/applications.ts`, `packages/engine/src/shorthop.ts`. Tables: `app_connections`, `app_short_links` (`migrations/0043_applications.sql`). Dashboard: `apps/dashboard/src/pages/Applications.tsx`, `apps/dashboard/src/editor/TrackableLinks.tsx`.

## Shorthop

[Shorthop](https://github.com/jntegz/shorthop) is a self-hosted link shortener. Connect it, and writers can turn links in a post into short links on your own domain:

- **One link:** the link, button and link card dialogs get **Shorten link**.
- **Every link in a post:** **Shorten all links** in the post's toolbar, and in a split-test variant's own toolbar. It changes links in text, buttons, link cards and images, and can be undone in the editor. It skips `mailto:` links, sponsor links (they count their own clicks) and raw HTML blocks.

### Connecting

An admin enters the Shorthop address and an API key that may read and create links. Swarm talks to its MCP server (`POST <address>/api/mcp`, Bearer key) and checks both before saving. The key is sealed with `FIELD_KEYS` together with the workspace, only its last four characters are ever shown, and browsers never talk to Shorthop. Addresses go through the outbound URL guard: https, a public host name. Disconnecting forgets the key; links in posts keep working, because they live in Shorthop.

### Slug format

The format sets the part of the link after the domain. The default is `{post}-{random}`.

| Token           | Becomes                                 |
| --------------- | --------------------------------------- |
| `{publication}` | The publication's address               |
| `{post}`        | The post's subject, up to 30 characters |
| `{date}`        | The day the link was made, `2026-11-04` |
| `{domain}`      | The destination's host name             |
| `{random}`      | Six random letters and digits           |

A slug is at most 64 letters, digits, `-` and `_`, as Shorthop requires. If it is taken, Swarm tries again with a random ending, so a format without `{random}` still works. Changing the format only affects new links.

Shorthop only accepts `https://` destinations, so an `http://` link stays as it is and is reported as not changed.

### What it does

- The same address in the same post gets the same link, so converting twice makes no duplicates.
- Links are tagged `swarm` and the publication's address in Shorthop, and titled with the post's subject.
- Writers (author role and up) can make links. Only admins can see or change the connection.

### Counting clicks

In an email, Swarm's own click tracking still wraps the link, so a click passes through Swarm and then Shorthop. Swarm separates people from link scanners; Shorthop counts what reaches it, which can include scanners that follow links in email. Swarm's post stats and Shorthop's numbers won't match exactly. Post stats list each link's destination.

A Flow that watches one link matches it by its original address or by the short link Swarm made, so shortening a post doesn't break it. Disconnecting Shorthop forgets which short link goes where, so after that a Flow has to name the address that's in the email.
