# Canvas Wrapper

ELMS Local is a private, read-only Chrome/Chromium overhaul for UMD Canvas. It uses the Canvas session you already authenticated through UMD and Duo, so it needs no personal API token, OAuth developer key, password storage, backend, or deployment.

## Install

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select the `extension` folder in this repository.
5. Click the ELMS Local toolbar icon and sign into UMD Canvas normally if prompted.

## Interface

- Today and a unified, filterable to-do list.
- Persistent hiding for stale overdue assignments.
- Canvas calendar events and a weekly schedule with optional recurring class times.
- Automatic exam, midterm, final, quiz, and test detection.
- Redesigned course pages with the instructor's original images and rich homepage content.
- Course-level Modules, Assignments, Announcements, and Grades.
- Dark and light themes.

The extension never creates sample classes or assignments. When Canvas returns nothing, the interface stays empty.

## Privacy

The extension has access only to `https://umd.instructure.com/*` and its data layer makes only same-origin `GET` requests. It contains no analytics, remote scripts, backend calls, or credential storage. Instructor-authored rich content is sanitized before it is displayed; externally hosted images referenced by an instructor may still load from their original host.

Theme, recurring meetings, local task checks, and hidden assignments are stored in the browser's local storage for the UMD Canvas origin.

See [`extension/README.md`](extension/README.md) for detailed behavior and update instructions.
