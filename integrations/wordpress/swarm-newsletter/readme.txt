=== Swarm Newsletter ===
Tags: newsletter, subscribe, email, forms, mcp
Requires at least: 6.5
Tested up to: 7.1
Requires PHP: 7.4
Stable tag: 0.1.0
License: GPL-2.0-or-later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Subscribe forms from your Swarm publication, and an optional MCP endpoint for AI agents.

== Description ==

Connects a WordPress site to a Swarm install, your own or a hosted one.

* Show a published Swarm form with the Swarm form block or `[swarm_form id="cf_…"]`.
* The form posts straight to Swarm from the visitor's browser, so subscriber addresses never pass through this site.
* Optionally lets AI agents reach Swarm through this site. It is off until you turn it on.

== External services ==

This plugin talks to the Swarm install you enter in Settings → Swarm. It sends your API key and asks for your publications and forms. When someone subscribes, their browser sends what they typed in the form to that Swarm install, and a Cloudflare Turnstile check runs there. Nothing is sent until you connect the plugin.

== Installation ==

1. Install and activate the plugin.
2. In Swarm, create an API key with `channels:read` and `forms:read`.
3. In Settings → Swarm, enter your Swarm address and the key, then choose a publication.
4. Add the Swarm form block to a page, or paste a shortcode from the settings page.
