# Templates and email design

This guide covers three things: the starter templates that come with Swarm, saving templates of your own, and how the emails Swarm sends are designed, including what they do in dark mode, on phones and in Outlook, and what goes in the footer.

## Starter templates

Open **Templates** in the dashboard. The **Starters** group at the top is there on a new install, with nothing to set up.

| Starter                     | Reach for it when                                                    |
| --------------------------- | -------------------------------------------------------------------- |
| Personal letter             | You have one idea and want to write it as a note to a friend         |
| Weekly roundup              | You are sharing links, each with a line of your own                  |
| Long-form essay             | You are making one argument properly, with sections                  |
| Announcement or launch      | You have one piece of news and one thing for readers to do about it  |
| Interview or Q&A            | You talked to a guest, or you are answering reader questions         |
| Product update or changelog | You are telling people what shipped, what was fixed and what is next |
| Invitation to go paid       | You are asking free readers to become paying subscribers             |
| Welcome issue               | You are writing the first email a new subscriber should read         |

Each starter comes with a suggested subject, suggested preview text and a full post. The sample text is a guide to itself: every paragraph says what belongs in that spot, so you can read the starter once as advice and then write over it.

- **Preview** shows the starter as an email in your publication's own design.
- **Use** creates a draft post from it and opens the editor. The draft is yours: change anything, delete sections, add blocks. The starter itself never changes, so you can use it again next week.

You can also get there from **New post → From a template**.

Before you send a post made from a starter:

- Replace the subject and the preview text.
- Replace every link. Links in starters point at `example.com`.
- Keep or change the greeting. `Hi {{ first_name | there }},` becomes "Hi Ada," for a subscriber whose first name you have, and "Hi there," for everyone else. The word after the bar is the fallback.
- Read it once in the preview and send yourself a test.

Viewers can preview starters. Starting a draft needs the author role or higher, as it does for any post.

## Your own templates

When a post has a shape you want to reuse, open it in the editor and choose **Save as template**. The template keeps the subject, preview text, cover image and body. Give it a name and, if you like, a description of when to use it. People with the editor role can tick **Share with every publication in the workspace**; otherwise the template belongs to the publication the post is in.

Saved templates are listed under **Your templates** on the Templates page:

- **Use** starts a draft from it.
- **Export HTML** downloads it as a finished HTML email.
- **Share with workspace** and **Keep to this publication** change who sees it.
- **Delete** removes it from the library. Posts already made from it are not affected.

**Import HTML** brings in an email you built elsewhere. It becomes a single raw HTML block, which Swarm sends exactly as written. That means the dark mode, phone and Outlook handling described below does not apply inside it, and posts made from it can only be sent where raw HTML is turned on.

## How your emails look

Every email is a 600 pixel wide card on a quiet page, with your publication's name at the top, the post in the middle and a footer underneath. With nothing configured it uses the reader's system font, near-black text on white, and Swarm's purple for links and buttons. A first post from a new install is meant to look finished without touching a setting.

Three places change the look:

1. **Website → Branding → Logo and accent colour.** The accent colour is used for buttons, links, quote bars and callouts in email too.
2. **Settings → Sending → Email design.** The font (system, Georgia or monospace), whether your logo shows at the top, a line under your name, your postal address, and colours for the page, the message card and the text.
3. **Custom email CSS**, if your install has it turned on, for anything else.

Swarm keeps your colours readable rather than applying them blindly:

- A button's label is white or near-black, whichever has more contrast on your accent colour. A yellow accent gets dark text.
- A link in the text uses your accent colour, darkened or lightened only as far as needed to be readable on the card.
- If you choose a text colour, headings use it as chosen and body text uses a slightly softer version of it. Captions, borders and tinted boxes are worked out from your card and text colours.
- If you choose a dark card and no text colour, the text turns light on its own.

### Dark mode

Emails declare that they support both light and dark, and carry a dark palette: a near-black page, a dark grey card, light text, and your accent colour lifted where it would otherwise be too dark to read. Mail apps that honour this (Apple Mail on Mac and iPhone, and Outlook on Mac, iPhone and Android) show that palette. Outlook.com gets the same colours through its own mechanism.

Some apps, Gmail among them, ignore what the email asks for and recolour it themselves. Light backgrounds with dark text, which is what Swarm sends, survive that well.

If you chose a dark card yourself, the email is already dark and stays exactly as you designed it in both modes.

Things to know:

- A logo with dark artwork on a transparent background can vanish on a dark card. Use a logo with its own background, or one that reads on both.
- Images are never recoloured.
- The **Dark** tab of the editor's preview shows the dark version and lists any text that would be hard to read. Raw HTML blocks and custom CSS are where such text comes from; ordinary blocks are always handled.

### Phones

Under 620 pixels wide the gutters shrink so the text gets the width, large headings step down a size, two-column blocks stack into one, and images scale to the screen. Body text stays at 16 pixels. Buttons are 46 pixels tall, comfortably tappable.

### Outlook on Windows

The desktop Outlook for Windows draws email with Microsoft Word, which ignores a good deal of ordinary web styling. Swarm's emails are built for it:

- The card sits in a fixed-width table that only Outlook sees, so it does not stretch across a wide window.
- Buttons, quotes, callouts, link cards, code and dividers are tables, because Outlook draws padding and borders reliably only on table cells.
- Images carry their width in pixels, sized to the column or box they sit in.
- Outlook is given a font it has (Segoe UI, Georgia or Consolas, matching your choice) and exact line heights.

What you will see differently there: corners are square, including on buttons, because Outlook does not draw rounded corners. Everything else lines up.

Swarm's own emails are tested in a browser at desktop and phone widths, in light and dark. They follow patterns long proven in Outlook but are not tested in Outlook itself on every release. Before an important send, send yourself a test and open it in the apps your readers use.

### Languages that read right to left

A post written mostly in Hebrew or Arabic script is laid out right to left: text aligns right, and quote bars, list indents and callout bars move to the right side.

### Size

Gmail cuts off emails over 102 KB and hides the rest behind a link. A typical post is 8 to 20 KB. The editor warns you when a post goes over the limit; long posts with many blocks, or large raw HTML blocks, are the usual cause. Images do not count, since they are linked and not embedded.

## The footer

Every post ends with a footer outside the card:

- **Why the reader is getting it:** "You are receiving this because you joined" and your publication's name.
- **Manage your subscription:** a link, personal to each reader, to the page where they change their details, pause or leave.
- **Unsubscribe:** a link that works without signing in. Mail apps that show their own unsubscribe button get the same thing through the email's headers.
- **Your postal address,** when you have entered one.

The reason line and the two links are part of every post; there is no setting that removes them. The plain-text version of the email carries the same footer.

### Postal address

Anti-spam laws in several countries, including CAN-SPAM in the United States and CASL in Canada, require commercial email to carry a postal address where the sender can be reached. Enter yours in **Settings → Sending → Email design → Postal address**. It is printed under the unsubscribe link in every post, in both the HTML and the plain-text version.

A PO box or a registered business address is fine if you would rather not print a home address. Swarm does not add an address for you and does not stop a send that has none, so set it before your first real send.

## System emails

The emails Swarm sends on your behalf (the confirmation a new subscriber gets, reader sign-in links, receipts) and the ones it sends to your team (your sign-in link, invites, security notices, warm-up pauses) use the same frame as posts in a narrower card: one heading, a few short lines and at most one button. They get the same dark mode, phone and Outlook handling, and always include a plain-text version. Emails to readers use your publication's name and accent colour.

If your install has message wording turned on, you can reword the reader-facing ones under **Settings → Sending**. Your wording goes into the same frame unless you choose to write the whole email in HTML yourself.
