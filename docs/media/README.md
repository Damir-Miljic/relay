# Relay media

[← Back to README](../../README.md)

## Automatic account-switch demo

[Watch the recording](automatic-switch.gif)

This 24-second animation shows a **real automatic switch between two distinct Claude accounts** in an isolated native terminal on Windows. The first account received a marker; after the switch, the second account recalled it from the same saved conversation.

**The quota readings are demo values**, injected into the isolated service to trigger the 10% threshold without exhausting real subscriptions. Each frame carries this notice. The recording verifies native switching and conversation continuity; it does not demonstrate real quota exhaustion or a provider handoff.

The animation uses Relay's actual dashboard renderer, with account names and session details restricted to neutral display fields. It does not contain raw terminal output, account identities, credentials, or conversation text. Repeated identical frames were combined while preserving their durations; the sequence was not sped up.

To reproduce the native recording, read and run [the recorder](../../scripts/record-switch-demo.mjs). It requires two connected, distinct Claude accounts and makes two small requests using real subscription usage. It creates a separate local Relay service and a disposable conversation, then cleans up that service's temporary state. The conversation remains in native history. It does not alter the normal Relay service or its sessions.

Rendering used [the dashboard preview renderer](../../scripts/render-dashboard-preview.ps1), followed by GIF encoding with `gifenc@1.0.3` and `pngjs@7.0.0` installed in a temporary development folder. Those packages are not Relay dependencies. Intermediate recordings and frames stay under the ignored `artifacts/` folder.

## Social preview

[Social preview image](social-preview.jpg) — 1774 × 887 pixels, 2:1, approximately 155 KiB.

This is a promotional graphic, not a screenshot. It was generated with the built-in image-generation tool and saved as JPEG at quality 92 to meet GitHub's file-size limit. The text, artwork, and layout were preserved during encoding.

Use this image under **Settings → General → Social preview** on GitHub. [GitHub's preview requirements](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/customizing-your-repositorys-social-media-preview).

<details>
<summary>Image-generation prompt</summary>

Use case: ads-marketing. Create a polished GitHub social-preview image for an open-source terminal application named Relay. Exact canvas 1280 by 640 pixels, 2:1 ratio, opaque background. Brand: very dark navy #0c111b background, mint #64dfc0 accent, restrained ice blue accents and off-white type, modern premium developer tool. This is a promotional title card, not a screenshot or fabricated evidence. Minimal, sharp, exceptionally readable typography and generous margins. Small mint monospaced R E L A Y at upper left. Main headline in very large off-white sans-serif text on two lines: 'Multiple accounts.' and 'No more logout, login, repeat.' Subtitle: 'Automatic account switching for Claude Code and Codex'. A small, elegant conceptual right-side motif of two account tiles connected by an arrow, purely decorative with no invented UI or percentages. Bottom left small text: 'Windows + macOS • Free & open source'. Bottom right author credit on two lines: 'By Damir Miljic' and 'linkedin.com/in/damirmiljic'. Keep all exact text spelled correctly and comfortably inside 64px margins. Avoid provider logos, robots, gradients, glowing effects, large illustrations, clutter, and additional text. Aim for flat colors and crisp text so the file compresses below 1 MB.

</details>

## Author credit

When sharing Relay, please credit **[Damir Miljic](https://linkedin.com/in/damirmiljic)** and link to [the repository](https://github.com/Damir-Miljic/relay). This is a courtesy request; the MIT license terms remain unchanged.
