# WordPress plugin

`integrations/wordpress/swarm-newsletter/` is a WordPress plugin that connects a site to a Swarm install. It shows published subscribe forms, as a block and as a shortcode, and can let AI agents reach Swarm's MCP server through the site. It needs WordPress 6.5 and PHP 7.4 or later. It adds nothing to the Swarm install beyond one read route, so there is no feature switch for it.

**Status:** tested on WordPress Playground (real WordPress and PHP in WebAssembly), on the newest WordPress and on the oldest versions it supports, against a local Swarm. It has not been run on a real web host, and it is not in the WordPress plugin directory.

To run the test: `pnpm test:wordpress`, or `WP_VERSION=6.5 PHP_VERSION=7.4 pnpm test:wordpress` for the oldest. Playground's PHP crashes on any network call inside a shortcode, so a shortcode's first fetch of a form can't be tested there. The same code runs in the tested block.

## Connecting

1. In Swarm, create an API key under Settings → Developers → API keys with `channels:read` and `forms:read`, limited to one publication if you can. Add more scopes only if you turn on agent access.
2. In WordPress, under Settings → Swarm, enter the address you sign in to Swarm at and the key, save, then choose the publication.

The key is stored in the site's database, and the settings page never shows it again. To keep it out of the database, define it in `wp-config.php`:

```php
define( 'SWARM_NL_API_KEY', 'sk_live_…' );
```

Uninstalling the plugin removes the saved key and everything else it stored.

## Forms

Add the **Swarm form** block, or paste the shortcode from the settings page:

```
[swarm_form id="cf_…"]
[swarm_form id="cf_…" mode="script"]
```

| `mode`            | What visitors get                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `plain` (default) | An HTML form in the page, with no JavaScript from Swarm until they submit. Inline only; style it with your theme.         |
| `script`          | Swarm's embed, with the form's own design and its popup, slide-in or sticky placement. Loads Swarm's script on that page. |

The form's HTML comes from `GET /v2/channels/{channelId}/capture-forms/{formId}/snippet`, so profile fields, consent and the spam trap are Swarm's. The plugin only filters the markup and prints it.

- **Subscriber addresses don't pass through WordPress.** The visitor's browser posts straight to Swarm's capture address. Swarm's rate limits apply to the visitor, not to the site.
- **After submitting**, a plain form leaves the site: Swarm shows its one-step person check, then the form's success message, or redirects to the success address you set on the form.
- **Allowed sites.** If the form lists allowed sites in Swarm, add this site's address there, or Swarm refuses the post.
- **Changes** to a form show up within five minutes. If Swarm can't be reached, the site keeps showing the last good copy of the form. A form Swarm no longer has disappears. Visitors never see an error; people who can edit posts see a short note in its place.

## Agent access

Off until an administrator ticks **Let AI agents reach Swarm through this site**. Then `POST /wp-json/swarm-newsletter/v1/mcp` forwards one MCP message to Swarm's `/mcp` ([open-operator.md](open-operator.md)) and answers with Swarm's bytes unchanged.

- **Who can call it:** a WordPress administrator, normally an MCP client using an [application password](https://wordpress.org/documentation/article/application-passwords/). WordPress only offers those over https, and some servers strip the `Authorization` header unless configured to pass it on.
- **Which key:** a separate **agent key**, set under the agent access setting or as `SWARM_NL_AGENT_KEY` in `wp-config.php`. Create it in Swarm as a key for "An AI agent" (surface `mcp`): it works on Swarm's MCP server only, so whoever takes over the site or reads its options can't use it to call `/v2` directly, past the approval holds. The bridge never forwards the site key (which should stay `channels:read` and `forms:read`). Without an agent key the route answers `503` and says what to add.
- **What it can do:** whatever the agent key allows. The client's WordPress login doesn't narrow it, so give the key only the scopes agents need.
- **Who did it:** every forwarded call carries `X-Swarm-Acting-For: WordPress <site host> user <id> (<login>)`, which Swarm adds to the client name in the agent log and the approval queue. It is the site's claim, beside the key Swarm verified: it tells the site's administrators apart while the site is honest.
- **Swarm's rules still apply:** scopes, the approval mode (sends and other destructive calls wait for a person by default) and the agent log, which records the agent key as the credential.

A direct connection to Swarm's `/mcp` is simpler and gives each agent its own key. Use this when an agent is already set up with the WordPress site, or can't be given a Swarm key.

```json
{
  "mcpServers": {
    "swarm": {
      "url": "https://example.com/wp-json/swarm-newsletter/v1/mcp",
      "headers": { "Authorization": "Basic <base64 of username:application-password>" }
    }
  }
}
```

## Licence

The plugin is GPL-2.0-or-later, as the WordPress plugin directory expects. The rest of this repository is AGPL-3.0.
