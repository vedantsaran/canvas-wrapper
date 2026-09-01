(() => {
  'use strict';

  const pageUrl = new URL(window.location.href);
  if (window.top !== window || pageUrl.searchParams.get('elms_local') !== '1') {
    return;
  }

  const STORAGE = {
    theme: 'elms-local:theme',
    completed: 'elms-local:completed',
    dismissed: 'elms-local:dismissed',
    hiddenCourses: 'elms-local:hidden-courses',
    meetings: 'elms-local:meetings',
  };
  const TONES = ['blue', 'pink', 'purple', 'gold', 'green'];
  const VIEWS = ['today', 'todo', 'schedule', 'exams', 'classes'];

  const state = {
    view: 'today',
    theme: readStorage(STORAGE.theme, 'dark'),
    data: null,
    warnings: [],
    syncing: false,
    weekStart: startOfWeek(new Date()),
    courseFilter: 'all',
    showCompleted: false,
    editingSchedule: false,
    selectedCourseId: null,
    courseTab: 'home',
    courseCache: new Map(),
    loadingCourse: false,
    courseError: '',
    completed: new Set(readJsonStorage(STORAGE.completed, [])),
    dismissed: new Set(readJsonStorage(STORAGE.dismissed, [])),
    hiddenCourses: new Set(readJsonStorage(STORAGE.hiddenCourses, [])),
    meetings: readJsonStorage(STORAGE.meetings, []),
  };

  window.stop();
  document.documentElement.classList.add('elms-local-active');
  document.title = 'ELMS Local';

  const root = document.createElement('div');
  root.id = 'elms-local-root';
  root.dataset.theme = state.theme === 'light' ? 'light' : 'dark';
  document.body.replaceChildren(root);

  root.addEventListener('click', handleClick);
  root.addEventListener('change', handleChange);
  root.addEventListener('submit', handleSubmit);

  renderGate('checking canvas session…');
  syncData({ initial: true });

  async function syncData({ initial = false } = {}) {
    state.syncing = true;
    if (!initial) renderShell();

    try {
      const [profile, rawCourses] = await Promise.all([
        fetchJson('/api/v1/users/self/profile'),
        fetchAll('/api/v1/courses?enrollment_state=active&state[]=available&include[]=term&include[]=course_image&include[]=total_scores&per_page=100'),
      ]);

      const courses = normalizeCourses(rawCourses);
      const activeCourseIds = new Set(courses.map((course) => course.id));
      const hiddenCourses = new Set([...state.hiddenCourses].filter((courseId) => activeCourseIds.has(courseId)));
      if (hiddenCourses.size !== state.hiddenCourses.size) {
        state.hiddenCourses = hiddenCourses;
        writeJsonStorage(STORAGE.hiddenCourses, [...hiddenCourses]);
      }
      const start = addDays(startOfDay(new Date()), -30).toISOString();
      const end = addDays(startOfDay(new Date()), 180).toISOString();
      const warnings = [];

      const plannerPromise = fetchAll(
        `/api/v1/planner/items?start_date=${encodeURIComponent(start)}&end_date=${encodeURIComponent(end)}&per_page=100`,
      ).catch(() => {
        warnings.push('assignments unavailable');
        return [];
      });

      const calendarCourses = courses.filter((course) => !state.hiddenCourses.has(course.id));
      const calendarPromise = fetchCalendarEvents(calendarCourses, start, end).catch(() => {
        warnings.push('calendar unavailable');
        return [];
      });

      const [plannerItems, calendarEvents] = await Promise.all([plannerPromise, calendarPromise]);
      const tasks = normalizeTasks(plannerItems, courses);
      const taskIds = new Set(tasks.map((task) => task.id));
      const dismissed = new Set([...state.dismissed].filter((taskId) => taskIds.has(taskId)));
      if (dismissed.size !== state.dismissed.size) {
        state.dismissed = dismissed;
        writeJsonStorage(STORAGE.dismissed, [...dismissed]);
      }

      const refreshCourseId = state.view === 'course' ? state.selectedCourseId : null;
      state.courseCache.clear();

      state.data = {
        profile: normalizeProfile(profile),
        courses,
        tasks,
        events: normalizeEvents(calendarEvents, courses),
      };
      state.warnings = warnings;
      state.syncing = false;
      if (refreshCourseId && activeCourseIds.has(refreshCourseId) && !state.hiddenCourses.has(refreshCourseId)) {
        await openCourse(refreshCourseId, { preserveTab: true });
        return;
      }
      if (refreshCourseId) {
        state.selectedCourseId = null;
        state.view = 'classes';
      }
      renderShell();
    } catch (error) {
      state.syncing = false;
      if (error instanceof CanvasAuthError) {
        renderLoginGate();
        return;
      }

      renderErrorGate(error);
    }
  }

  async function fetchCalendarEvents(courses, start, end) {
    if (!courses.length) return [];

    const chunks = [];
    for (let index = 0; index < courses.length; index += 10) {
      chunks.push(courses.slice(index, index + 10));
    }

    const responses = await Promise.all(
      chunks.map((chunk) => {
        const params = new URLSearchParams({
          type: 'event',
          start_date: start,
          end_date: end,
          per_page: '100',
        });
        chunk.forEach((course) => params.append('context_codes[]', `course_${course.id}`));
        return fetchAll(`/api/v1/calendar_events?${params.toString()}`);
      }),
    );

    return responses.flat();
  }

  async function openCourse(courseId, { preserveTab = false } = {}) {
    const course = state.data.courses.find((item) => item.id === courseId);
    if (!course || state.hiddenCourses.has(courseId)) return;

    state.selectedCourseId = courseId;
    if (!preserveTab) state.courseTab = 'home';
    state.view = 'course';
    state.courseError = '';

    if (state.courseCache.has(courseId)) {
      renderShell();
      return;
    }

    state.loadingCourse = true;
    renderShell();

    try {
      const encodedId = encodeURIComponent(courseId);
      const [courseDetail, frontPage, rawModules, assignments, announcements, enrollments] = await Promise.all([
        fetchJson(`/api/v1/courses/${encodedId}?include[]=term&include[]=course_image&include[]=syllabus_body&include[]=total_scores`).catch(() => null),
        fetchJson(`/api/v1/courses/${encodedId}/front_page`).catch(() => null),
        fetchAll(`/api/v1/courses/${encodedId}/modules?include[]=items&include[]=content_details&per_page=100`).catch(() => []),
        fetchAll(`/api/v1/courses/${encodedId}/assignments?include[]=submission&order_by=due_at&per_page=100`).catch(() => []),
        fetchAll(`/api/v1/courses/${encodedId}/discussion_topics?only_announcements=true&order_by=recent_activity&per_page=50`).catch(() => []),
        fetchAll(`/api/v1/courses/${encodedId}/enrollments?user_id=self&type[]=StudentEnrollment&include[]=current_points&per_page=10`).catch(() => []),
      ]);

      const modules = await Promise.all(rawModules.map(async (module) => {
        if (Array.isArray(module.items)) return module;
        const items = await fetchAll(
          `/api/v1/courses/${encodedId}/modules/${encodeURIComponent(module.id)}/items?include[]=content_details&per_page=100`,
        ).catch(() => []);
        return { ...module, items };
      }));

      const homeSource = frontPage?.body || courseDetail?.syllabus_body || '';
      state.courseCache.set(courseId, {
        heroUrl: safeImageUrl(courseDetail?.image_download_url || course.imageUrl || ''),
        homeHtml: sanitizeCourseHtml(homeSource),
        modules,
        assignments,
        announcements,
        enrollment: enrollments.find((enrollment) => String(enrollment.type || '').includes('Student')) || enrollments[0] || null,
      });
      state.courseError = '';
    } catch (error) {
      state.courseError = error?.message || 'Course data could not be loaded.';
    } finally {
      state.loadingCourse = false;
      renderShell();
    }
  }

  async function fetchAll(path) {
    const records = [];
    let next = new URL(path, window.location.origin).toString();
    let page = 0;

    while (next && page < 20) {
      const { data, response } = await fetchJsonWithResponse(next);
      if (!Array.isArray(data)) throw new Error('Canvas returned an unexpected response.');
      records.push(...data);
      next = getNextLink(response.headers.get('Link'));
      page += 1;
    }

    return records;
  }

  async function fetchJson(path) {
    const { data } = await fetchJsonWithResponse(path);
    return data;
  }

  async function fetchJsonWithResponse(path) {
    const url = new URL(path, window.location.origin);
    if (url.origin !== window.location.origin) throw new Error('Blocked a non-Canvas request.');

    const response = await fetch(url.toString(), {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });

    if (response.status === 401) throw new CanvasAuthError();
    if (!response.ok) throw new Error(`Canvas request failed (${response.status}).`);

    const contentType = response.headers.get('Content-Type') || '';
    if (!contentType.toLowerCase().includes('application/json')) throw new CanvasAuthError();

    return { data: await response.json(), response };
  }

  function getNextLink(header) {
    if (!header) return null;
    const part = header.split(',').find((value) => /rel="?next"?/.test(value));
    if (!part) return null;
    const match = part.match(/<([^>]+)>/);
    if (!match) return null;

    try {
      const url = new URL(match[1], window.location.origin);
      return url.origin === window.location.origin ? url.toString() : null;
    } catch {
      return null;
    }
  }

  function normalizeProfile(profile) {
    return {
      id: String(profile?.id || ''),
      name: cleanText(profile?.short_name || profile?.name || 'Canvas user'),
    };
  }

  function normalizeCourses(rawCourses) {
    return rawCourses
      .filter((course) => course && course.id && !course.access_restricted_by_date)
      .map((course, index) => {
        const code = cleanText(course.course_code || course.name || `Course ${index + 1}`);
        const term = cleanText(course.term?.name || '');
        return {
          id: String(course.id),
          code,
          name: courseDisplayName(course.name || course.course_code || `Course ${index + 1}`, code, term),
          term,
          url: `/courses/${course.id}`,
          imageUrl: safeImageUrl(course.image_download_url || ''),
          tone: TONES[index % TONES.length],
        };
      })
      .sort((a, b) => a.code.localeCompare(b.code));
  }

  function normalizeTasks(items, courses) {
    const courseMap = new Map(courses.map((course) => [course.id, course]));

    return items
      .filter((item) => item?.plannable)
      .map((item) => {
        const plannable = item.plannable;
        const courseId = getCourseId(plannable.course_id || item.course_id || item.context?.id);
        const course = courseMap.get(courseId);
        const date = parseCanvasDate(plannable.due_at || plannable.todo_date || item.plannable_date);
        const submission = item.submissions || item.submission || {};
        const workflow = String(submission.workflow_state || '');
        const submitted = Boolean(
          submission.submitted ||
          submission.excused ||
          ['submitted', 'graded', 'pending_review', 'complete'].includes(workflow),
        );
        const rawId = plannable.id || item.plannable_id || item.id;

        return {
          id: `${item.plannable_type || 'item'}-${rawId || `${courseId}-${date?.toISOString() || 'undated'}`}`,
          title: cleanText(plannable.title || item.context_name || 'Untitled item'),
          courseId,
          courseName: course?.code || cleanText(item.context_name || 'Canvas'),
          tone: course?.tone || 'blue',
          dueAt: date,
          submitted,
          url: safeUrl(plannable.html_url || item.html_url || plannable.url || '#'),
        };
      })
      .filter((task) => task.dueAt)
      .sort((a, b) => a.dueAt - b.dueAt);
  }

  function normalizeEvents(events, courses) {
    const courseMap = new Map(courses.map((course) => [course.id, course]));

    return events
      .map((event) => {
        const courseId = getCourseId(event.context_code || event.course_id);
        const course = courseMap.get(courseId);
        const startsAt = parseCanvasDate(event.start_at || event.all_day_date);
        const endsAt = parseCanvasDate(event.end_at || event.all_day_date);

        return {
          id: `event-${event.id || `${courseId}-${startsAt?.toISOString() || 'undated'}`}`,
          title: cleanText(event.title || 'Untitled event'),
          courseId,
          courseName: course?.code || cleanText(event.context_name || 'Canvas'),
          tone: course?.tone || 'purple',
          startsAt,
          endsAt,
          allDay: Boolean(event.all_day),
          location: cleanText(event.location_name || event.location_address || ''),
          url: safeUrl(event.html_url || event.url || '#'),
        };
      })
      .filter((event) => event.startsAt)
      .sort((a, b) => a.startsAt - b.startsAt);
  }

  function renderShell() {
    if (!state.data) return;

    root.dataset.theme = state.theme;
    root.dataset.view = state.view;
    root.innerHTML = `
      <aside class="elms-side-rail">
        <button class="elms-wordmark" type="button" data-view="today">elms</button>
        <nav class="elms-nav" aria-label="Wrapper views">
          ${VIEWS.map((view) => `
            <button type="button" data-view="${view}" class="${state.view === view ? 'is-active' : ''}">
              ${view === 'todo' ? 'to-do' : view}
            </button>
          `).join('')}
        </nav>
      </aside>

      <main class="elms-main">
        <div class="elms-top-line">
          <span>umd canvas</span>
          <div class="elms-top-actions">
            <span class="elms-theme" aria-label="Theme">
              <button type="button" data-theme="dark" class="${state.theme === 'dark' ? 'is-selected' : ''}">dark</button>
              <span>/</span>
              <button type="button" data-theme="light" class="${state.theme === 'light' ? 'is-selected' : ''}">light</button>
            </span>
            <button class="elms-back" type="button" data-back-canvas>canvas ↗</button>
          </div>
        </div>
        <div data-view-content>${renderView()}</div>
      </main>

      <aside class="elms-status-rail" aria-label="Canvas status">
        <button type="button" data-sync ${state.syncing ? 'disabled' : ''}>${state.syncing ? 'syncing…' : 'sync now'}</button>
        ${state.warnings.map((warning) => `<p>${esc(warning)}</p>`).join('')}
      </aside>
    `;
  }

  function renderView() {
    switch (state.view) {
      case 'todo':
        return renderTodo();
      case 'schedule':
        return renderSchedule();
      case 'exams':
        return renderExams();
      case 'classes':
        return renderClasses();
      case 'course':
        return renderCourse();
      default:
        return renderToday();
    }
  }

  function renderToday() {
    const now = new Date();
    const visibleTasks = getVisibleTasks()
      .filter((task) => !isTaskComplete(task))
      .filter((task) => task.dueAt >= addDays(startOfDay(now), -14))
      .slice(0, 5);
    const todayMeetings = getVisibleMeetings()
      .filter((meeting) => Number(meeting.day) === now.getDay())
      .map((meeting) => meetingEventForDate(meeting, now));
    const todayEvents = [
      ...getVisibleEvents().filter((event) => sameDay(event.startsAt, now)),
      ...todayMeetings,
    ].sort((left, right) => left.startsAt - right.startsAt);
    const nextExam = getExams().find((exam) => exam.date >= startOfDay(now));

    return `
      ${pageHeading('today', formatLongDate(now))}
      <section class="elms-section">
        ${sectionHeading('due soon', 'to-do')}
        ${renderTaskList(visibleTasks)}
      </section>
      <section class="elms-section">
        ${sectionHeading('calendar', 'schedule')}
        ${renderEventList(todayEvents)}
      </section>
      <section class="elms-section">
        ${sectionHeading('next exam', 'exams')}
        ${nextExam ? renderNextExam(nextExam) : emptyRow('No upcoming exams found in Canvas.')}
      </section>
    `;
  }

  function renderTodo() {
    const courses = getVisibleCourses();
    const tasks = getVisibleTasks().filter((task) => {
      const courseMatches = state.courseFilter === 'all' || task.courseId === state.courseFilter;
      const completionMatches = state.showCompleted || !isTaskComplete(task);
      return courseMatches && completionMatches;
    });

    return `
      ${pageHeading('to-do', `${tasks.length} ${tasks.length === 1 ? 'item' : 'items'}`)}
      <div class="elms-filter-line">
        <label>
          class
          <select data-course-filter>
            <option value="all">all classes</option>
            ${courses.map((course) => `<option value="${esc(course.id)}" ${state.courseFilter === course.id ? 'selected' : ''}>${esc(course.code)}</option>`).join('')}
          </select>
        </label>
        <label>
          <input type="checkbox" data-show-completed ${state.showCompleted ? 'checked' : ''}>
          show completed
        </label>
        ${state.dismissed.size ? `<button class="elms-restore" type="button" data-restore-hidden>restore ${state.dismissed.size} hidden</button>` : ''}
      </div>
      <section class="elms-section elms-flush">
        ${renderTaskList(tasks)}
      </section>
    `;
  }

  function renderSchedule() {
    const days = Array.from({ length: 7 }, (_, index) => addDays(state.weekStart, index));
    const courses = getVisibleCourses();
    const meetings = getVisibleMeetings().sort((left, right) => (
      meetingDayOrder(left.day) - meetingDayOrder(right.day) || left.start.localeCompare(right.start)
    ));

    return `
      ${pageHeading('schedule', weekRangeLabel(state.weekStart))}
      ${renderClassTimes(meetings)}
      ${state.editingSchedule ? renderMeetingEditor(courses) : ''}
      <div class="elms-week-controls">
        <button type="button" data-week="previous">← previous</button>
        <button type="button" data-week="today">this week</button>
        <button type="button" data-week="next">next →</button>
      </div>
      <div class="elms-week-grid" aria-label="Weekly calendar">
        ${days.map((day) => renderScheduleDay(day)).join('')}
      </div>
    `;
  }

  function renderClassTimes(meetings) {
    const days = [1, 2, 3, 4, 5, 6, 0];
    return `
      <section class="elms-class-times">
        <header>
          <div>
            <h2>class times</h2>
            <span>${meetings.length ? `${meetings.length} weekly ${meetings.length === 1 ? 'meeting' : 'meetings'}` : 'none added'}</span>
          </div>
          <button type="button" data-edit-schedule>${state.editingSchedule ? 'close' : meetings.length ? 'edit' : 'add class times'}</button>
        </header>
        ${meetings.length ? `<div class="elms-class-days">${days.map((day) => {
          const dayMeetings = meetings.filter((meeting) => Number(meeting.day) === day);
          if (!dayMeetings.length) return '';
          return `
            <section class="elms-class-day">
              <h3>${esc(longWeekday(day))}</h3>
              <div>${dayMeetings.map((meeting) => `
                <div class="elms-class-time-row">
                  <time>${esc(storedTimeRange(meeting.start, meeting.end))}</time>
                  <span class="elms-dot tone-${meeting.tone}"></span>
                  <span>
                    <strong>${esc(meeting.courseName)}</strong>
                    ${meeting.location ? `<small>${esc(meeting.location)}</small>` : ''}
                  </span>
                  <button type="button" data-remove-meeting="${esc(meeting.id)}" aria-label="Remove ${esc(meeting.courseName)} on ${esc(longWeekday(day))}">remove</button>
                </div>
              `).join('')}</div>
            </section>
          `;
        }).join('')}</div>` : '<p class="elms-empty">Add your meeting days and times once; they repeat every week.</p>'}
      </section>
    `;
  }

  function renderMeetingEditor(courses) {
    return `
      <form class="elms-meeting-form">
        <div class="elms-meeting-fields">
          <label class="elms-meeting-course">
            class
            <select name="courseId" required>
              <option value="">select</option>
              ${courses.map((course) => `<option value="${esc(course.id)}">${esc(course.code)} · ${esc(course.name)}</option>`).join('')}
            </select>
          </label>
          <label>
            starts
            <input type="time" name="start" required>
          </label>
          <label>
            ends
            <input type="time" name="end" required>
          </label>
          <label class="elms-location">
            location
            <input type="text" name="location" maxlength="80" autocomplete="off" placeholder="optional">
          </label>
        </div>
        <fieldset class="elms-meeting-days">
          <legend>meets on</legend>
          <div>
            ${[[1, 'mon'], [2, 'tue'], [3, 'wed'], [4, 'thu'], [5, 'fri'], [6, 'sat'], [0, 'sun']].map(([day, label]) => `
              <label><input type="checkbox" name="days" value="${day}"> ${label}</label>
            `).join('')}
          </div>
        </fieldset>
        <button type="submit">add to schedule</button>
      </form>
    `;
  }

  function renderScheduleDay(day) {
    const events = getVisibleEvents()
      .filter((event) => sameDay(event.startsAt, day))
      .map((event) => ({
        id: event.id,
        title: event.title,
        courseName: event.courseName,
        location: event.location,
        date: event.startsAt,
        end: event.endsAt,
        allDay: event.allDay,
        tone: event.tone,
        url: event.url,
      }));

    const meetings = getVisibleMeetings()
      .filter((meeting) => Number(meeting.day) === day.getDay())
      .map((meeting) => {
        const event = meetingEventForDate(meeting, day);
        return { ...event, date: event.startsAt, end: event.endsAt, kind: 'class' };
      });

    const deadlines = getVisibleTasks()
      .filter((task) => !isTaskComplete(task) && sameDay(task.dueAt, day))
      .map((task) => ({
        id: task.id,
        title: task.title,
        courseName: `${task.courseName} · due`,
        location: '',
        date: task.dueAt,
        end: task.dueAt,
        allDay: false,
        tone: task.tone,
        url: task.url,
        kind: 'deadline',
      }));

    const entries = [...events, ...meetings, ...deadlines].sort((a, b) => a.date - b.date);

    return `
      <section class="elms-day ${sameDay(day, new Date()) ? 'is-today' : ''}">
        <div class="elms-day-heading">
          <span>${day.toLocaleDateString(undefined, { weekday: 'short' }).toLowerCase()}</span>
          <strong>${day.getDate()}</strong>
        </div>
        <div class="elms-day-events">
          ${entries.map((entry) => renderCalendarEntry(entry)).join('')}
        </div>
      </section>
    `;
  }

  function meetingEventForDate(meeting, day) {
    return {
      id: meeting.id,
      title: meeting.courseName,
      courseId: meeting.courseId,
      courseName: 'class',
      location: meeting.location,
      startsAt: timeOnDate(day, meeting.start),
      endsAt: timeOnDate(day, meeting.end),
      allDay: false,
      tone: meeting.tone,
      url: '#',
    };
  }

  function renderCalendarEntry(entry) {
    const content = `
      <time>${entry.allDay ? 'all day' : formatTimeRange(entry.date, entry.end)}</time>
      <strong>${esc(entry.title)}</strong>
      <small>${esc([entry.courseName, entry.location].filter(Boolean).join(' · '))}</small>
    `;

    if (entry.url && entry.url !== '#') {
      return `<a class="elms-calendar-entry ${entry.kind ? `is-${entry.kind}` : ''} border-${entry.tone}" href="${esc(entry.url)}">${content}</a>`;
    }
    return `<div class="elms-calendar-entry ${entry.kind ? `is-${entry.kind}` : ''} border-${entry.tone}">${content}</div>`;
  }

  function renderExams() {
    const exams = getExams();
    return `
      ${pageHeading('exams', `${exams.length} found`)}
      <section class="elms-section elms-flush">
        ${exams.length ? `<div class="elms-exam-list">${exams.map((exam) => renderExam(exam)).join('')}</div>` : emptyRow('No exams found in assignments or calendar events.')}
      </section>
    `;
  }

  function renderClasses() {
    const courses = getVisibleCourses();
    const hiddenCount = state.data.courses.filter((course) => state.hiddenCourses.has(course.id)).length;
    return `
      ${pageHeading('classes', `${courses.length} active`, hiddenCount ? `restore ${hiddenCount} hidden` : '', 'restore-courses')}
      <section class="elms-section elms-flush">
        ${courses.length ? `<div class="elms-course-list">${courses.map((course) => `
          <div class="elms-course-row">
            <button class="elms-course" type="button" data-course-open="${esc(course.id)}">
              <strong class="tone-${course.tone}">${esc(course.code)}</strong>
              <span>${esc(course.name)}</span>
              <span>${esc(course.term)}</span>
            </button>
            <button class="elms-course-hide" type="button" data-hide-course="${esc(course.id)}" aria-label="Hide ${esc(course.code)}">hide</button>
          </div>
        `).join('')}</div>` : emptyRow(hiddenCount ? 'All active classes are hidden.' : 'Canvas returned no active classes.')}
      </section>
    `;
  }

  function renderCourse() {
    const course = state.data.courses.find((item) => item.id === state.selectedCourseId);
    if (!course || state.hiddenCourses.has(course.id)) return emptyRow('Course not found.');

    const detail = state.courseCache.get(course.id);
    return `
      <div class="elms-course-shell">
        <button class="elms-course-back" type="button" data-course-back>← classes</button>
        <header class="elms-course-header">
          <div>
            <p class="elms-course-kicker tone-${course.tone}">${esc(course.code)}${course.term ? ` · ${esc(course.term)}` : ''}</p>
            <h1>${esc(course.name)}</h1>
          </div>
          <div class="elms-course-actions">
            <button type="button" data-hide-course="${esc(course.id)}">hide class</button>
            <a href="${esc(course.url)}">canvas ↗</a>
          </div>
        </header>
        <nav class="elms-course-tabs" aria-label="Course sections">
          ${['home', 'modules', 'assignments', 'announcements', 'grades'].map((tab) => `
            <button type="button" data-course-tab="${tab}" class="${state.courseTab === tab ? 'is-active' : ''}">${tab}</button>
          `).join('')}
        </nav>
        <div class="elms-course-content">
          ${state.loadingCourse ? emptyRow('loading…') : state.courseError ? emptyRow(state.courseError) : detail ? renderCourseTab(course, detail) : emptyRow('Course data unavailable.')}
        </div>
      </div>
    `;
  }

  function renderCourseTab(course, detail) {
    switch (state.courseTab) {
      case 'modules':
        return renderCourseModules(detail);
      case 'assignments':
        return renderCourseAssignments(course, detail);
      case 'announcements':
        return renderCourseAnnouncements(detail);
      case 'grades':
        return renderCourseGrades(detail);
      default:
        return renderCourseHome(course, detail);
    }
  }

  function renderCourseHome(course, detail) {
    const upcoming = getVisibleTasks()
      .filter((task) => task.courseId === course.id && !isTaskComplete(task))
      .slice(0, 5);
    const hasGradedWork = detail.assignments.some((assignment) => (
      assignment.submission?.workflow_state === 'graded' || assignment.submission?.score != null
    ));
    const grade = hasGradedWork ? currentCourseGrade(detail.enrollment) : '';

    return `
      ${detail.heroUrl ? `<div class="elms-course-hero"><img src="${esc(detail.heroUrl)}" alt="" loading="eager"></div>` : ''}
      <div class="elms-course-home-grid ${detail.homeHtml ? '' : 'without-page'}">
        ${detail.homeHtml ? `<article class="elms-course-rich">${detail.homeHtml}</article>` : ''}
        <aside class="elms-course-glance">
          ${grade ? `<section><h2>grade</h2><strong class="elms-grade-large">${esc(grade)}</strong></section>` : ''}
          <section>
            <h2>upcoming</h2>
            ${upcoming.length ? upcoming.map((task) => `
              <a class="elms-mini-assignment" href="${esc(task.url)}">
                <strong>${esc(task.title)}</strong>
                <span>${esc(dueLabel(task.dueAt))}</span>
              </a>
            `).join('') : '<p>nothing due</p>'}
          </section>
        </aside>
      </div>
    `;
  }

  function renderCourseModules(detail) {
    if (!detail.modules.length) return emptyRow('No modules published.');

    return `<div class="elms-module-list">${detail.modules.map((module) => `
      <section class="elms-module">
        <header>
          <h2>${esc(module.name || 'Module')}</h2>
          <span>${Array.isArray(module.items) ? module.items.length : 0}</span>
        </header>
        <div>
          ${(module.items || []).map(renderCourseModuleItem).join('') || '<p class="elms-empty">Empty module.</p>'}
        </div>
      </section>
    `).join('')}</div>`;
  }

  function renderCourseModuleItem(item) {
    const title = cleanText(item.title || 'Untitled item');
    if (item.type === 'SubHeader') {
      return `<div class="elms-module-subheader"><strong>${esc(title)}</strong></div>`;
    }

    const dueAt = parseCanvasDate(item.content_details?.due_at);
    const status = dueAt ? dueLabel(dueAt) : item.completion_requirement?.completed ? 'done' : '';
    const href = safeContentUrl(item.html_url || item.external_url || '');
    const body = `
      <span>${esc(courseItemType(item.type))}</span>
      <strong>${esc(title)}</strong>
      <small>${esc(status)}</small>
    `;

    if (!href) return `<div class="elms-module-item is-static">${body}</div>`;

    const external = new URL(href, window.location.origin).origin !== window.location.origin;
    return `<a class="elms-module-item" href="${esc(href)}"${external ? ' target="_blank" rel="noreferrer noopener"' : ''}>${body}</a>`;
  }

  function renderCourseAssignments(course, detail) {
    if (!detail.assignments.length) return emptyRow('No assignments published.');

    return `<div class="elms-course-assignment-list">${detail.assignments.map((assignment) => {
      const dueAt = parseCanvasDate(assignment.due_at);
      const submission = assignment.submission || {};
      const status = submission.workflow_state === 'graded'
        ? formatScore(submission.score, assignment.points_possible)
        : submission.submitted_at ? 'submitted' : dueAt ? dueLabel(dueAt) : 'no due date';
      return `
        <a class="elms-course-assignment" href="${esc(safeUrl(assignment.html_url || `/courses/${course.id}/assignments/${assignment.id}`))}">
          <span class="elms-assignment-mark tone-${course.tone}"></span>
          <span>
            <strong>${esc(cleanText(assignment.name || 'Untitled assignment'))}</strong>
            <small>${esc(assignment.points_possible == null ? '' : `${assignment.points_possible} points`)}</small>
          </span>
          <span>${esc(status)}</span>
        </a>
      `;
    }).join('')}</div>`;
  }

  function renderCourseAnnouncements(detail) {
    if (!detail.announcements.length) return emptyRow('No announcements.');

    return `<div class="elms-announcement-list">${detail.announcements.map((announcement) => {
      const postedAt = parseCanvasDate(announcement.posted_at);
      return `
        <article class="elms-announcement">
          <header>
            <div>
              <h2>${esc(cleanText(announcement.title || 'Announcement'))}</h2>
              <p>${esc(cleanText(announcement.author?.display_name || ''))}${postedAt ? ` · ${esc(formatShortDate(postedAt))}` : ''}</p>
            </div>
            <a href="${esc(safeUrl(announcement.html_url || '#'))}">open ↗</a>
          </header>
          <div class="elms-course-rich compact">${sanitizeCourseHtml(announcement.message || '')}</div>
        </article>
      `;
    }).join('')}</div>`;
  }

  function renderCourseGrades(detail) {
    const graded = detail.assignments.filter((assignment) => assignment.submission?.workflow_state === 'graded');
    const grade = graded.length ? currentCourseGrade(detail.enrollment) : '';

    return `
      ${grade ? `<div class="elms-grade-summary"><span>current grade</span><strong>${esc(grade)}</strong></div>` : ''}
      ${graded.length ? `<div class="elms-grade-list">${graded.map((assignment) => `
        <a href="${esc(safeUrl(assignment.html_url || '#'))}">
          <span>${esc(cleanText(assignment.name || 'Assignment'))}</span>
          <strong>${esc(formatScore(assignment.submission?.score, assignment.points_possible))}</strong>
        </a>
      `).join('')}</div>` : emptyRow('No graded work available.')}
    `;
  }

  function renderTaskList(tasks) {
    if (!tasks.length) return emptyRow('Nothing here.');

    return `<div class="elms-task-list">${tasks.map((task) => {
      const complete = isTaskComplete(task);
      const overdue = isTaskOverdue(task);
      return `
        <div class="elms-task ${complete ? 'is-complete' : ''}">
          <input id="${esc(task.id)}" type="checkbox" data-task-id="${esc(task.id)}" ${complete ? 'checked' : ''} ${task.submitted ? 'disabled' : ''}>
          <label class="elms-check" for="${esc(task.id)}" aria-label="Mark ${esc(task.title)} complete"></label>
          <span class="elms-task-copy">
            <a href="${esc(task.url)}">${esc(task.title)}</a>
            <span class="elms-course-label tone-${task.tone}">${esc(task.courseName)}</span>
          </span>
          <time datetime="${task.dueAt.toISOString()}">${esc(dueLabel(task.dueAt))}</time>
          ${overdue ? `<button class="elms-dismiss" type="button" data-dismiss-task="${esc(task.id)}" aria-label="Hide ${esc(task.title)} permanently">hide</button>` : ''}
        </div>
      `;
    }).join('')}</div>`;
  }

  function renderEventList(events) {
    if (!events.length) return emptyRow('Nothing scheduled today.');

    return `<ul class="elms-event-list">${events.map((event) => `
      <li>
        <time datetime="${event.startsAt.toISOString()}">${event.allDay ? 'all day' : formatTimeRange(event.startsAt, event.endsAt)}</time>
        <span class="elms-dot tone-${event.tone}"></span>
        <span>
          ${event.url && event.url !== '#' ? `<a href="${esc(event.url)}">${esc(event.title)}</a>` : `<strong>${esc(event.title)}</strong>`}
          <small>${esc([event.courseName, event.location].filter(Boolean).join(' · '))}</small>
        </span>
      </li>
    `).join('')}</ul>`;
  }

  function renderNextExam(exam) {
    return `
      <a class="elms-next-exam" href="${esc(exam.url)}">
        <time datetime="${exam.date.toISOString()}">${formatShortDate(exam.date)}</time>
        <span><strong>${esc(exam.title)}</strong> <small class="tone-${exam.tone}">${esc(exam.courseName)}</small></span>
        <span class="elms-countdown">${esc(countdown(exam.date))}</span>
      </a>
    `;
  }

  function renderExam(exam) {
    return `
      <a class="elms-exam" href="${esc(exam.url)}">
        <time datetime="${exam.date.toISOString()}">
          <strong>${exam.date.getDate()}</strong>
          <span>${exam.date.toLocaleDateString(undefined, { month: 'short' })}</span>
        </time>
        <span class="elms-exam-copy">
          <span class="elms-course-label tone-${exam.tone}">${esc(exam.courseName)}</span>
          <strong>${esc(exam.title)}</strong>
          <small>${exam.allDay ? 'all day' : formatTime(exam.date)}${exam.location ? ` · ${esc(exam.location)}` : ''}</small>
        </span>
        <span class="elms-confidence ${exam.confidence}">${exam.confidence}</span>
        <span class="elms-countdown">${esc(countdown(exam.date))}</span>
      </a>
    `;
  }

  function getExams() {
    const confirmed = /\b(final|midterm|exam(?:ination)?)\b/i;
    const likely = /\b(quiz|test)\b/i;
    const candidates = [];

    getVisibleTasks().forEach((task) => {
      const confidence = confirmed.test(task.title) ? 'confirmed' : likely.test(task.title) ? 'likely' : null;
      if (!confidence) return;
      candidates.push({
        id: task.id,
        title: task.title,
        courseName: task.courseName,
        tone: task.tone,
        date: task.dueAt,
        allDay: false,
        location: '',
        url: task.url,
        confidence,
      });
    });

    getVisibleEvents().forEach((event) => {
      const confidence = confirmed.test(event.title) ? 'confirmed' : likely.test(event.title) ? 'likely' : null;
      if (!confidence) return;
      candidates.push({
        id: event.id,
        title: event.title,
        courseName: event.courseName,
        tone: event.tone,
        date: event.startsAt,
        allDay: event.allDay,
        location: event.location,
        url: event.url,
        confidence,
      });
    });

    const deduped = new Map();
    candidates.forEach((exam) => {
      const key = `${exam.courseName.toLowerCase()}|${exam.title.toLowerCase()}|${localDateKey(exam.date)}`;
      if (!deduped.has(key)) deduped.set(key, exam);
    });

    return [...deduped.values()]
      .filter((exam) => exam.date >= addDays(startOfDay(new Date()), -1))
      .sort((a, b) => a.date - b.date);
  }

  function pageHeading(title, detail, actionLabel = '', action = '') {
    return `
      <header class="elms-page-heading">
        <h1>${esc(title)}</h1>
        <div class="elms-page-meta">
          <p>${esc(detail)}</p>
          ${actionLabel ? `<button type="button" data-${action}>${esc(actionLabel)}</button>` : ''}
        </div>
      </header>
    `;
  }

  function sectionHeading(title, view) {
    return `
      <div class="elms-section-heading">
        <h2>${esc(title)}</h2>
        <button type="button" data-view="${esc(view)}">view all →</button>
      </div>
    `;
  }

  function emptyRow(message) {
    return `<p class="elms-empty">${esc(message)}</p>`;
  }

  function renderGate(message) {
    root.innerHTML = `
      <main class="elms-gate">
        <div class="elms-gate-inner">
          <h1>elms</h1>
          <p>${esc(message)}</p>
        </div>
      </main>
    `;
  }

  function renderLoginGate() {
    root.innerHTML = `
      <main class="elms-gate">
        <div class="elms-gate-inner">
          <h1>elms</h1>
          <p>Sign in to UMD Canvas first.</p>
          <a href="/login?return_to=%2F%3Felms_local%3D1">log in with umd →</a>
        </div>
      </main>
    `;
  }

  function renderErrorGate(error) {
    root.innerHTML = `
      <main class="elms-gate">
        <div class="elms-gate-inner">
          <h1>elms</h1>
          <p>${esc(error?.message || 'Canvas data could not be loaded.')}</p>
          <button type="button" data-retry>try again</button>
        </div>
      </main>
    `;
  }

  function handleClick(event) {
    const hideCourseButton = event.target.closest('button[data-hide-course]');
    if (hideCourseButton) {
      const courseId = hideCourseButton.dataset.hideCourse;
      state.hiddenCourses.add(courseId);
      state.courseCache.delete(courseId);
      if (state.courseFilter === courseId) state.courseFilter = 'all';
      if (state.selectedCourseId === courseId) {
        state.selectedCourseId = null;
        state.view = 'classes';
      }
      writeJsonStorage(STORAGE.hiddenCourses, [...state.hiddenCourses]);
      renderShell();
      return;
    }

    if (event.target.closest('button[data-restore-courses]')) {
      state.hiddenCourses.clear();
      writeJsonStorage(STORAGE.hiddenCourses, []);
      syncData();
      return;
    }

    const courseButton = event.target.closest('button[data-course-open]');
    if (courseButton) {
      openCourse(courseButton.dataset.courseOpen);
      return;
    }

    if (event.target.closest('button[data-course-back]')) {
      state.view = 'classes';
      renderShell();
      return;
    }

    const courseTab = event.target.closest('button[data-course-tab]');
    if (courseTab && ['home', 'modules', 'assignments', 'announcements', 'grades'].includes(courseTab.dataset.courseTab)) {
      state.courseTab = courseTab.dataset.courseTab;
      renderShell();
      return;
    }

    const dismissButton = event.target.closest('[data-dismiss-task]');
    if (dismissButton) {
      state.dismissed.add(dismissButton.dataset.dismissTask);
      writeJsonStorage(STORAGE.dismissed, [...state.dismissed]);
      renderShell();
      return;
    }

    if (event.target.closest('[data-restore-hidden]')) {
      state.dismissed.clear();
      writeJsonStorage(STORAGE.dismissed, []);
      renderShell();
      return;
    }

    const viewButton = event.target.closest('button[data-view]');
    if (viewButton) {
      state.view = VIEWS.includes(viewButton.dataset.view) ? viewButton.dataset.view : 'today';
      renderShell();
      return;
    }

    const themeButton = event.target.closest('button[data-theme]');
    if (themeButton && ['dark', 'light'].includes(themeButton.dataset.theme)) {
      state.theme = themeButton.dataset.theme;
      writeStorage(STORAGE.theme, state.theme);
      renderShell();
      return;
    }

    if (event.target.closest('[data-sync]') || event.target.closest('[data-retry]')) {
      syncData();
      return;
    }

    if (event.target.closest('[data-back-canvas]')) {
      window.location.assign('/');
      return;
    }

    if (event.target.closest('[data-edit-schedule]')) {
      state.editingSchedule = !state.editingSchedule;
      renderShell();
      return;
    }

    const weekButton = event.target.closest('[data-week]');
    if (weekButton) {
      if (weekButton.dataset.week === 'previous') state.weekStart = addDays(state.weekStart, -7);
      if (weekButton.dataset.week === 'next') state.weekStart = addDays(state.weekStart, 7);
      if (weekButton.dataset.week === 'today') state.weekStart = startOfWeek(new Date());
      renderShell();
      return;
    }

    const removeButton = event.target.closest('[data-remove-meeting]');
    if (removeButton) {
      state.meetings = state.meetings.filter((meeting) => meeting.id !== removeButton.dataset.removeMeeting);
      writeJsonStorage(STORAGE.meetings, state.meetings);
      renderShell();
    }
  }

  function handleChange(event) {
    if (event.target.matches('.elms-meeting-form [name="days"]')) {
      event.target.closest('.elms-meeting-form').querySelectorAll('[name="days"]').forEach((input) => input.setCustomValidity(''));
      return;
    }

    if (event.target.matches('.elms-meeting-form [name="start"], .elms-meeting-form [name="end"]')) {
      const endInput = event.target.closest('.elms-meeting-form').querySelector('[name="end"]');
      endInput?.setCustomValidity('');
      return;
    }

    if (event.target.matches('[data-task-id]')) {
      const id = event.target.dataset.taskId;
      if (event.target.checked) state.completed.add(id);
      else state.completed.delete(id);
      writeJsonStorage(STORAGE.completed, [...state.completed]);
      renderShell();
      return;
    }

    if (event.target.matches('[data-course-filter]')) {
      state.courseFilter = event.target.value;
      renderShell();
      return;
    }

    if (event.target.matches('[data-show-completed]')) {
      state.showCompleted = event.target.checked;
      renderShell();
    }
  }

  function handleSubmit(event) {
    if (!event.target.matches('.elms-meeting-form')) return;
    event.preventDefault();

    const formData = new FormData(event.target);
    const course = state.data.courses.find((item) => item.id === formData.get('courseId'));
    const start = String(formData.get('start') || '');
    const end = String(formData.get('end') || '');
    const days = [...new Set(formData.getAll('days').map(Number).filter((day) => Number.isInteger(day) && day >= 0 && day <= 6))];
    if (!course || !start || !end) return;

    if (!days.length) {
      const firstDay = event.target.querySelector('[name="days"]');
      firstDay?.setCustomValidity('Choose at least one meeting day.');
      firstDay?.reportValidity();
      return;
    }

    if (end <= start) {
      const endInput = event.target.querySelector('[name="end"]');
      endInput?.setCustomValidity('End time must be after the start time.');
      endInput?.reportValidity();
      return;
    }

    const location = cleanText(formData.get('location') || '').slice(0, 80);
    const additions = days
      .filter((day) => !state.meetings.some((meeting) => (
        meeting.courseId === course.id && Number(meeting.day) === day && meeting.start === start && meeting.end === end
      )))
      .map((day, index) => ({
        id: globalThis.crypto?.randomUUID?.() || `meeting-${Date.now()}-${day}-${index}`,
        courseId: course.id,
        courseName: course.code,
        tone: course.tone,
        day,
        start,
        end,
        location,
      }));

    state.meetings.push(...additions);
    writeJsonStorage(STORAGE.meetings, state.meetings);
    renderShell();
  }

  function isTaskComplete(task) {
    return task.submitted || state.completed.has(task.id);
  }

  function isTaskOverdue(task) {
    return !isTaskComplete(task) && task.dueAt.getTime() < Date.now();
  }

  function getVisibleTasks() {
    return state.data.tasks.filter((task) => !state.dismissed.has(task.id) && !state.hiddenCourses.has(task.courseId));
  }

  function getVisibleCourses() {
    return state.data.courses.filter((course) => !state.hiddenCourses.has(course.id));
  }

  function getVisibleEvents() {
    return state.data.events.filter((event) => !state.hiddenCourses.has(event.courseId));
  }

  function getVisibleMeetings() {
    return state.meetings.filter((meeting) => !state.hiddenCourses.has(meeting.courseId));
  }

  function currentCourseGrade(enrollment) {
    const grades = enrollment?.grades;
    if (!grades) return '';
    const letter = cleanText(grades.current_grade || grades.final_grade || '');
    const score = grades.current_score ?? grades.final_score;
    if (letter && score != null) return `${letter} · ${Number(score).toFixed(1).replace(/\.0$/, '')}%`;
    if (letter) return letter;
    if (score != null) return `${Number(score).toFixed(1).replace(/\.0$/, '')}%`;
    return '';
  }

  function formatScore(score, possible) {
    if (score == null) return '—';
    const earned = Number(score).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
    if (possible == null) return earned;
    const total = Number(possible).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
    return `${earned} / ${total}`;
  }

  function courseItemType(type) {
    const labels = {
      Assignment: 'assignment',
      Discussion: 'discussion',
      File: 'file',
      Page: 'page',
      Quiz: 'quiz',
      ExternalTool: 'external',
      ExternalUrl: 'link',
      SubHeader: '',
    };
    return labels[type] ?? cleanText(type || 'item').toLowerCase();
  }

  function sanitizeCourseHtml(value) {
    if (!value) return '';

    const allowed = new Set([
      'a', 'article', 'audio', 'b', 'blockquote', 'br', 'code', 'details', 'div', 'em', 'figcaption', 'figure',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'li', 'ol', 'p', 'pre', 's', 'section',
      'source', 'span', 'strong', 'summary', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'track',
      'u', 'ul', 'video',
    ]);
    const embedded = new Set(['embed', 'iframe', 'object']);
    const blocked = new Set(['base', 'button', 'form', 'input', 'link', 'meta', 'script', 'style', 'textarea']);
    const parsed = new DOMParser().parseFromString(String(value), 'text/html');
    const output = document.createElement('div');

    const copyNode = (node) => {
      if (node.nodeType === Node.TEXT_NODE) return document.createTextNode(node.textContent || '');
      if (node.nodeType !== Node.ELEMENT_NODE) return null;

      const tag = node.tagName.toLowerCase();
      if (blocked.has(tag)) return null;
      if (embedded.has(tag)) return createRichEmbed(node, tag);

      if (!allowed.has(tag)) {
        const fragment = document.createDocumentFragment();
        [...node.childNodes].forEach((child) => {
          const copy = copyNode(child);
          if (copy) fragment.append(copy);
        });
        return fragment;
      }

      const element = document.createElement(tag);
      if (tag === 'a') {
        const href = safeContentUrl(node.getAttribute('href'));
        if (href) {
          element.setAttribute('href', href);
          if (new URL(href, window.location.origin).origin !== window.location.origin) {
            element.setAttribute('target', '_blank');
            element.setAttribute('rel', 'noreferrer noopener');
          }
        }
      }
      if (tag === 'img') {
        const src = safeImageUrl(node.getAttribute('src'));
        if (!src) return null;
        element.setAttribute('src', src);
        element.setAttribute('alt', cleanText(node.getAttribute('alt') || ''));
        element.setAttribute('loading', 'lazy');
        const width = Number(node.getAttribute('width'));
        const height = Number(node.getAttribute('height'));
        if (Number.isFinite(width) && width > 0) element.setAttribute('width', String(width));
        if (Number.isFinite(height) && height > 0) element.setAttribute('height', String(height));
      }
      if (tag === 'video' || tag === 'audio') {
        const src = safeContentUrl(node.getAttribute('src'));
        if (src) element.setAttribute('src', src);
        element.setAttribute('controls', '');
        element.setAttribute('preload', 'metadata');
        if (tag === 'video') {
          const poster = safeImageUrl(node.getAttribute('poster'));
          if (poster) element.setAttribute('poster', poster);
          element.setAttribute('playsinline', '');
        }
      }
      if (tag === 'source') {
        const src = safeContentUrl(node.getAttribute('src'));
        if (!src) return null;
        element.setAttribute('src', src);
        const type = cleanText(node.getAttribute('type') || '');
        if (/^(audio|video)\/[a-z0-9.+-]+$/i.test(type)) element.setAttribute('type', type);
      }
      if (tag === 'track') {
        const src = safeContentUrl(node.getAttribute('src'));
        if (!src) return null;
        element.setAttribute('src', src);
        const kind = cleanText(node.getAttribute('kind') || '').toLowerCase();
        if (['captions', 'chapters', 'descriptions', 'metadata', 'subtitles'].includes(kind)) element.setAttribute('kind', kind);
        const label = cleanText(node.getAttribute('label') || '');
        const language = cleanText(node.getAttribute('srclang') || '');
        if (label) element.setAttribute('label', label);
        if (/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language)) element.setAttribute('srclang', language);
        if (node.hasAttribute('default')) element.setAttribute('default', '');
      }
      if (['td', 'th'].includes(tag)) {
        const colspan = Number(node.getAttribute('colspan'));
        const rowspan = Number(node.getAttribute('rowspan'));
        if (Number.isInteger(colspan) && colspan > 1 && colspan < 20) element.setAttribute('colspan', String(colspan));
        if (Number.isInteger(rowspan) && rowspan > 1 && rowspan < 20) element.setAttribute('rowspan', String(rowspan));
      }
      if (tag === 'details' && node.hasAttribute('open')) element.setAttribute('open', '');

      [...node.childNodes].forEach((child) => {
        const copy = copyNode(child);
        if (copy) element.append(copy);
      });
      return element;
    };

    [...parsed.body.childNodes].forEach((node) => {
      const copy = copyNode(node);
      if (copy) output.append(copy);
    });
    output.querySelectorAll('h1, h2, h3, h4, h5, h6, p').forEach((element) => {
      const hasMedia = element.querySelector('audio, figure, iframe, img, table, video');
      if (!cleanText(element.textContent || '') && !hasMedia) element.remove();
    });
    return output.innerHTML;
  }

  function createRichEmbed(node, tag) {
    let rawSource = tag === 'object' ? node.getAttribute('data') : node.getAttribute('src');
    if (!rawSource && tag === 'object') {
      const movie = [...node.querySelectorAll('param')].find((param) => param.getAttribute('name')?.toLowerCase() === 'movie');
      rawSource = movie?.getAttribute('value') || '';
    }

    const src = safeContentUrl(rawSource);
    if (!src) return null;

    const kind = richEmbedKind(src);
    const title = cleanText(node.getAttribute('title') || (kind === 'video' ? 'Embedded video' : 'Embedded course content'));
    const figure = document.createElement('figure');
    figure.className = `elms-rich-embed is-${kind}`;

    const frame = document.createElement('iframe');
    frame.className = 'elms-rich-frame';
    frame.setAttribute('src', src);
    frame.setAttribute('title', title);
    frame.setAttribute('loading', 'lazy');
    frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    frame.setAttribute('sandbox', 'allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-presentation allow-same-origin allow-scripts');
    frame.setAttribute('allow', 'autoplay; encrypted-media; fullscreen; picture-in-picture');
    frame.setAttribute('allowfullscreen', '');
    figure.append(frame);

    const caption = document.createElement('figcaption');
    const link = document.createElement('a');
    link.setAttribute('href', src);
    link.setAttribute('target', '_blank');
    link.setAttribute('rel', 'noreferrer noopener');
    link.textContent = 'open embed ↗';
    caption.append(link);
    figure.append(caption);
    return figure;
  }

  function richEmbedKind(value) {
    try {
      const url = new URL(value, window.location.origin);
      const source = `${url.hostname}${url.pathname}`.toLowerCase();
      return /(youtube(?:-nocookie)?\.com\/embed|youtu\.be\/|player\.vimeo\.com\/video|panopto|instructuremedia|media_attachments|media_objects|arc\/media)/.test(source)
        ? 'video'
        : 'document';
    } catch {
      return 'document';
    }
  }

  function safeContentUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(String(value), window.location.origin);
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : url.toString();
    } catch {
      return '';
    }
  }

  function safeImageUrl(value) {
    return safeContentUrl(value);
  }

  function safeUrl(value) {
    if (!value || value === '#') return '#';
    try {
      const url = new URL(String(value), window.location.origin);
      if (url.origin !== window.location.origin) return '#';
      return `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return '#';
    }
  }

  function getCourseId(value) {
    const text = String(value || '');
    const match = text.match(/(?:course_)?(\d+)/);
    return match ? match[1] : text;
  }

  function courseDisplayName(value, code, term) {
    let name = cleanText(value || code);
    const colon = name.indexOf(':');
    const courseKey = code.toLowerCase().replace(/[^a-z0-9]/g, '');
    const prefixKey = name.slice(0, colon).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (colon > 0 && courseKey && prefixKey.includes(courseKey)) {
      name = name.slice(colon + 1).trim();
    }

    if (term) {
      const termIndex = name.toLowerCase().lastIndexOf(term.toLowerCase());
      if (termIndex > 0 && /[-–—]\s*$/.test(name.slice(0, termIndex))) {
        name = name.slice(0, termIndex).replace(/[-–—]\s*$/, '').trim();
      }
    }
    return cleanText(name || code);
  }

  function cleanText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function esc(value) {
    return String(value ?? '')
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  function readStorage(key, fallback) {
    try {
      return window.localStorage.getItem(key) || fallback;
    } catch {
      return fallback;
    }
  }

  function writeStorage(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // The wrapper remains usable if site storage is disabled.
    }
  }

  function readJsonStorage(key, fallback) {
    try {
      const value = JSON.parse(window.localStorage.getItem(key) || 'null');
      return Array.isArray(value) ? value : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJsonStorage(key, value) {
    writeStorage(key, JSON.stringify(value));
  }

  function parseCanvasDate(value) {
    if (!value) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      const [year, month, day] = String(value).split('-').map(Number);
      return new Date(year, month - 1, day, 12);
    }
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function startOfDay(date) {
    const value = new Date(date);
    value.setHours(0, 0, 0, 0);
    return value;
  }

  function startOfWeek(date) {
    const value = startOfDay(date);
    const offset = value.getDay() === 0 ? -6 : 1 - value.getDay();
    return addDays(value, offset);
  }

  function addDays(date, amount) {
    const value = new Date(date);
    value.setDate(value.getDate() + amount);
    return value;
  }

  function sameDay(left, right) {
    return localDateKey(left) === localDateKey(right);
  }

  function localDateKey(date) {
    const value = new Date(date);
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }

  function timeOnDate(date, time) {
    const [hours, minutes] = String(time).split(':').map(Number);
    const value = new Date(date);
    value.setHours(hours || 0, minutes || 0, 0, 0);
    return value;
  }

  function formatTime(date) {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }).toLowerCase();
  }

  function formatTimeRange(start, end) {
    if (!end || sameMinute(start, end)) return formatTime(start);
    return `${formatTime(start)}–${formatTime(end)}`;
  }

  function storedTimeRange(start, end) {
    const reference = new Date(2026, 0, 5);
    return formatTimeRange(timeOnDate(reference, start), timeOnDate(reference, end));
  }

  function sameMinute(left, right) {
    return left.getFullYear() === right.getFullYear() &&
      left.getMonth() === right.getMonth() &&
      left.getDate() === right.getDate() &&
      left.getHours() === right.getHours() &&
      left.getMinutes() === right.getMinutes();
  }

  function formatLongDate(date) {
    return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).toLowerCase();
  }

  function formatShortDate(date) {
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }).toLowerCase();
  }

  function dueLabel(date) {
    const today = startOfDay(new Date());
    const target = startOfDay(date);
    const days = Math.round((target - today) / 86400000);
    if (days < 0) return `${Math.abs(days)}d overdue`;
    if (days === 0) return `today · ${formatTime(date)}`;
    if (days === 1) return `tomorrow · ${formatTime(date)}`;
    return `${formatShortDate(date)} · ${formatTime(date)}`;
  }

  function countdown(date) {
    const days = Math.ceil((startOfDay(date) - startOfDay(new Date())) / 86400000);
    if (days < 0) return `${Math.abs(days)}d ago`;
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    return `${days}d`;
  }

  function weekRangeLabel(start) {
    const end = addDays(start, 6);
    const sameMonth = start.getMonth() === end.getMonth();
    if (sameMonth) {
      return `${start.toLocaleDateString(undefined, { month: 'long' })} ${start.getDate()}–${end.getDate()}`.toLowerCase();
    }
    return `${formatShortDate(start)}–${formatShortDate(end)}`;
  }

  function longWeekday(day) {
    return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][day] || '';
  }

  function meetingDayOrder(day) {
    const value = Number(day);
    return value === 0 ? 7 : value;
  }

  class CanvasAuthError extends Error {}
})();
