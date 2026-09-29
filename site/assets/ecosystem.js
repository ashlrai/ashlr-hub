/* The chart uses a dated GitHub snapshot. It never turns a failed read into 0. */
(() => {
  const snapshot = window.ASHLR_STAR_SNAPSHOT;
  const notice = document.getElementById('data-notice');
  const chart = document.getElementById('star-chart');
  if (!snapshot || snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.repos)
      || snapshot.repos.length !== 6 || !Number.isFinite(Date.parse(snapshot.asOf))) {
    notice.textContent = 'The star snapshot is unavailable. Open the repositories below for current counts on GitHub.';
    chart.hidden = true;
    return;
  }

  const repos = snapshot.repos;
  const allDays = repos.flatMap((repo) => repo.days);
  if (repos.some((repo) => !Number.isInteger(repo.stars) || repo.stars < 0
      || !Array.isArray(repo.days) || repo.days.length !== repo.stars
      || repo.days.some((day) => !/^\d{4}-\d{2}-\d{2}$/.test(day)))) {
    notice.textContent = 'The star snapshot is incomplete. Open GitHub for current counts.';
    chart.hidden = true;
    return;
  }

  const asOfDay = snapshot.asOf.slice(0, 10);
  const total = repos.reduce((sum, repo) => sum + repo.stars, 0);
  document.getElementById('total-stars').textContent = String(total);
  document.getElementById('snapshot-date').textContent = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium', timeZone: 'UTC',
  }).format(new Date(`${asOfDay}T00:00:00Z`));
  for (const repo of repos) {
    const cell = document.querySelector(`[data-repo-stars="${repo.repo}"]`);
    if (cell) {
      cell.textContent = String(repo.stars);
      const unit = cell.parentElement?.querySelector('small');
      if (unit) unit.textContent = repo.stars === 1 ? 'star' : 'stars';
    }
  }

  const seriesButtons = [...document.querySelectorAll('[data-series]')];
  const rangeButtons = [...document.querySelectorAll('[data-range]')];
  const cursor = document.getElementById('history-cursor');
  const output = document.getElementById('history-reading');
  const title = document.getElementById('series-title');
  const path = document.getElementById('history-path');
  const cursorLine = document.getElementById('cursor-line');
  const cursorDot = document.getElementById('cursor-dot');
  const svgDesc = document.getElementById('chart-description');
  const tickTop = document.getElementById('tick-top');
  const tickMid = document.getElementById('tick-mid');
  const tickZero = document.getElementById('tick-zero');
  const tickStart = document.getElementById('tick-start');
  const tickEnd = document.getElementById('tick-end');
  const svg = document.getElementById('history-svg');
  const colors = {
    all: '#7dd8de', 'ashlr-hub': '#aba1ff', 'phantom-secrets': '#7dd8de',
    locus: '#f1c374', lexicon: '#f19cb3', ashlrcode: '#a8d48e', morphkit: '#91b8f6',
  };
  let selected = 'all';
  let range = 'all';
  let selectedIndex = -1;
  let displayed = [];
  let currentMax = 1;
  let left = 58;
  let right = 930;

  const utcDay = (text) => Math.floor(Date.parse(`${text}T00:00:00Z`) / 86400000);
  const dayText = (ordinal) => new Date(ordinal * 86400000).toISOString().slice(0, 10);
  const formatDay = (day) => new Intl.DateTimeFormat('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  }).format(new Date(`${day}T00:00:00Z`));
  const xOf = (index, count) => left + (index / Math.max(1, count - 1)) * (right - left);
  const yOf = (value) => 244 - (value / currentMax) * 194;

  function setChartWidth() {
    const narrow = window.matchMedia('(max-width:560px)').matches;
    left = narrow ? 42 : 58;
    right = narrow ? 334 : 930;
    svg.setAttribute('viewBox', narrow ? '0 0 370 294' : '0 0 1000 294');
    svg.querySelectorAll('.grid').forEach((line) => {
      line.setAttribute('x1', left);
      line.setAttribute('x2', right);
    });
    [tickTop, tickMid, tickZero].forEach((tick) => tick.setAttribute('x', left - 12));
    tickStart.setAttribute('x', left);
    tickEnd.setAttribute('x', right);
  }

  function points() {
    const chosen = selected === 'all' ? repos : repos.filter((repo) => repo.repo === selected);
    const events = chosen.flatMap((repo) => repo.days).sort();
    const first = Math.min(utcDay(allDays[0] || asOfDay), ...allDays.map(utcDay));
    const end = utcDay(asOfDay);
    const start = range === '90d' ? Math.max(first, end - 89) : first;
    const result = [];
    let event = 0;
    for (let day = first; day <= end; day++) {
      const text = dayText(day);
      while (event < events.length && events[event] <= text) event++;
      if (day >= start) result.push({ day: text, count: event });
    }
    return result;
  }

  function stepPath(values) {
    if (!values.length) return '';
    let d = `M ${xOf(0, values.length).toFixed(2)} ${yOf(values[0].count).toFixed(2)}`;
    for (let index = 1; index < values.length; index++) {
      const x = xOf(index, values.length).toFixed(2);
      d += ` H ${x} V ${yOf(values[index].count).toFixed(2)}`;
    }
    return d;
  }

  function readAt(index) {
    if (!displayed.length) return;
    selectedIndex = Math.max(0, Math.min(displayed.length - 1, index));
    const point = displayed[selectedIndex];
    const label = selected === 'all' ? 'selected repositories' : repos.find((repo) => repo.repo === selected).name;
    const unit = point.count === 1 ? 'star' : 'stars';
    output.textContent = `${point.count} ${unit} across ${label} on ${formatDay(point.day)}`;
    cursorLine.setAttribute('x1', xOf(selectedIndex, displayed.length));
    cursorLine.setAttribute('x2', xOf(selectedIndex, displayed.length));
    cursorDot.setAttribute('cx', xOf(selectedIndex, displayed.length));
    cursorDot.setAttribute('cy', yOf(point.count));
    cursor.value = String(selectedIndex);
  }

  function render() {
    setChartWidth();
    displayed = points();
    currentMax = Math.max(1, ...displayed.map((point) => point.count));
    path.setAttribute('d', stepPath(displayed));
    chart.style.setProperty('--chart-line', colors[selected]);
    title.textContent = selected === 'all' ? 'Six repositories, one measured timeline' : repos.find((repo) => repo.repo === selected).name;
    tickTop.textContent = String(currentMax);
    tickMid.textContent = String(Math.round(currentMax / 2));
    tickStart.textContent = formatDay(displayed[0].day);
    tickEnd.textContent = formatDay(displayed[displayed.length - 1].day);
    const selectedName = selected === 'all' ? 'the six selected repositories' : repos.find((repo) => repo.repo === selected).name;
    svgDesc.textContent = `Cumulative repo stars for ${selectedName}, ${range === '90d' ? 'last 90 days' : 'all available history'}, from ${tickStart.textContent} to ${tickEnd.textContent}. The slider gives exact dated values.`;
    cursor.max = String(displayed.length - 1);
    readAt(selectedIndex < 0 ? displayed.length - 1 : selectedIndex);
    seriesButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.series === selected)));
    rangeButtons.forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.range === range)));
  }

  seriesButtons.forEach((button) => button.addEventListener('click', () => {
    selected = button.dataset.series;
    selectedIndex = -1;
    render();
  }));
  rangeButtons.forEach((button) => button.addEventListener('click', () => {
    range = button.dataset.range;
    selectedIndex = -1;
    render();
  }));
  cursor.addEventListener('input', () => readAt(Number(cursor.value)));
  window.addEventListener('resize', () => render());
  notice.textContent = 'A dated GitHub snapshot. Counts can change; open each repository for its live total.';
  render();
})();
