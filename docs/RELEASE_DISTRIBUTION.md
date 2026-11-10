# Release distribution

How a Harness Remote release reaches the people who use it: where it is installable, how its notes are published and how its documentation and screenshots stay current. The product roadmap is in [ROADMAP_4.md](ROADMAP_4.md).

Principles:

- **Driven by the release itself.** Every step runs in CI from the release tag or on a schedule, using the release notes already required in the tag annotation. Nothing is written by hand per channel, so every channel says the same thing.
- **Release information only.** Each publication is the release notes of a real version, sent once per release to official project channels. No unsolicited posting to communities, no automated pull requests to third-party lists, no in-app prompts asking for stars or ratings, no tracking of users.
- **No runtime dependency.** These channels distribute releases; the app itself never depends on them (see ROADMAP_4 §2).

## 1. Installable from the usual package managers

On every release tag, CI publishes or updates:

| Channel | How | Notes |
| --- | --- | --- |
| npm | existing `npm-publish.yml` | unchanged |
| GitHub Releases | existing release workflows | unchanged |
| Google Play | upload the AAB already built by `android-aab.yml` through the Play Developer API (internal track, then production) | requires the one-time Play account in §6 |
| F-Droid | reproducible-build metadata in the repository; F-Droid builds each new tag itself | possible because the app uses no proprietary push library (ROADMAP_4 E2) |
| winget | manifest update pull request generated from the release assets | Windows desktop |
| Homebrew | project tap `giuliastro/homebrew-tap`, bumped by CI | macOS desktop and CLI |
| Scoop | project bucket, bumped by CI | Windows CLI |

## 2. Release notes on official project channels

After a GitHub Release is published, one workflow publishes the same notes, unchanged, to:

- a post in the project's GitHub Discussions **Releases** category;
- the project's own Bluesky and Mastodon accounts (version, headline, link to the release);
- a project release feed (RSS/Atom) on the documentation site;
- an optional chat channel (Telegram or Discord) for people who chose to follow releases.

A release with no user-facing change (for example a CI-only fix) is not announced.

## 3. Documentation generated from the repository

The documentation site on GitHub Pages is rebuilt on every release from files already in the repository:

- one setup page per supported harness, generated from `V3_HARNESS_CAPABILITY_MATRIX.md` and `DEPENDENCIES.md`;
- one page per release from `docs/releases/*.md`;
- `sitemap.xml` and a short `llms.txt` describing what the product does and how to install it, so search engines and assistants answer setup questions correctly.

## 4. Screenshots and short demo recorded by CI

The existing Chromium smoke rig drives the web app against a fixture gateway and records, on every release:

- light/dark and narrow/wide screenshots used by the README and the documentation;
- a short clip of the release's main change, attached to the GitHub Release.

Documentation images are therefore never older than the current release.

## 5. Adoption metrics for maintainers

A weekly workflow stores public, aggregate repository numbers in `metrics/adoption.csv` on a `metrics` branch:

- npm downloads and GitHub release asset downloads per platform;
- stars and forks;
- GitHub traffic views, referrers and popular pages (kept by GitHub for 14 days only, hence the weekly capture);
- Play and F-Droid install counts where their reports are available.

This tells maintainers which platforms and install paths people actually use. No data is collected from the app.

## 6. One-time setup

| Item | Cost | Enables |
| --- | --- | --- |
| Google Play developer account and API service account | $25 once | §1 Google Play |
| F-Droid metadata merge request | — | §1 F-Droid |
| Repository secrets for the winget, tap and bucket updates | — | §1 |
| Project Bluesky and Mastodon accounts, release chat channel | — | §2 |
| Enable GitHub Discussions with a Releases category | — | §2 |

## 7. Order

1. §5 metrics, so the effect of each later step is visible.
2. §1 Google Play, winget, Homebrew and Scoop; F-Droid after ROADMAP_4 E2.
3. §4 screenshots and clip, then §2 release notes.
4. §3 documentation site.
