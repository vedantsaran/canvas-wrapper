# ELMS Local

A private Chrome/Chromium extension that turns your signed-in UMD Canvas session into a minimal dashboard.

It does not use a Canvas API token, OAuth developer key, or your UMD password. You sign in through the normal UMD/Duo page. The wrapper then makes read-only requests to Canvas from the same `umd.instructure.com` tab.

## Install locally

1. Open `chrome://extensions` in Chrome, Edge, Arc, Brave, or another Chromium browser.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this `extension` folder.
5. Pin **ELMS Local** if you want it visible in the toolbar.

Click the extension icon. If Canvas asks you to sign in, complete the normal UMD/Duo login and click the icon again.

## What it shows

- **Today:** upcoming work, today's calendar events, and the next detected exam.
- **To-do:** Canvas planner assignments, with class filtering, a local checklist, and persistent hiding for overdue work.
- **Schedule:** a recurring multi-day class timetable, Canvas calendar events, and outstanding assignment deadlines in one weekly view.
- **Exams:** upcoming items whose titles contain exam, examination, midterm, final, quiz, or test.
- **Classes:** active Canvas courses that open into redesigned course pages.
- **Course pages:** sanitized rich home content with its original images, responsive video and document embeds, plus Modules, Assignments, Announcements, and Grades.
- **Hidden classes:** hiding a class persistently removes that class, its assignments, announcements, exams, calendar events, and recurring meetings from the wrapper until restored.

The extension never creates fake courses or assignments. Empty Canvas data produces an empty state.

## Privacy and permissions

The manifest grants access only to `https://umd.instructure.com/*`. The data layer sends only `GET` requests to Canvas API routes on that same origin. It has no analytics, remote scripts, backend, or password/token storage. Course-page HTML is sanitized before display: scripts, forms, event attributes, unsafe URLs, and arbitrary embed permissions are discarded. Safe video, audio, Canvas preview, and document sources can render in constrained players. Every framed embed includes a direct-open fallback for providers that block framing. Externally hosted course media still loads from its original host.

Manual weekly meetings, theme choice, local task checks, hidden overdue assignments, and hidden classes are stored in `localStorage` for `umd.instructure.com`. Submitted/graded status remains read-only from Canvas. Hidden assignments and classes have separate restore controls in their respective views.

The normal Canvas interface is untouched. The overhaul activates only at `https://umd.instructure.com/?elms_local=1`; choose **canvas ↗** to return to the original interface.

## Updating

After changing any file in this folder, open `chrome://extensions` and click the reload button on the ELMS Local card.
