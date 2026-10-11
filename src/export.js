const TargetListExport = (() => {
  const csvHeaders = ['ID', 'Name', 'Faction ID', 'Faction', 'Estimated stats', 'Estimate source',
    'Estimate updated at', 'Reason', 'Status', 'Status description', 'Status until', 'Checked at',
    'Last active', 'Reserved by another member', 'Reservation expires at', 'Profile URL', 'Attack URL'];
  const markdownHeaders = ['Player', 'Faction', 'Estimated stats', 'Estimate source', 'Estimate updated',
    'Reason', 'Status', 'Checked at', 'Last active', 'Attack'];

  function text(value) { return typeof value === 'string' ? value : ''; }
  function id(value) { return Number.isSafeInteger(value) && value > 0 && value <= 2147483647 ? value : ''; }
  function stat(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : ''; }
  function date(value) {
    if (!Number.isFinite(value)) return '';
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
  }
  function unixDate(value) { return typeof value === 'number' && value > 0 ? date(value * 1000) : ''; }
  function stringDate(value) { return typeof value === 'string' && value.trim() ? date(Date.parse(value)) : ''; }
  function record(target) {
    const value = target && typeof target === 'object' ? target : {};
    const playerId = id(value.id);
    const factionId = id(value.faction?.id);
    return [playerId, text(value.name), factionId, text(value.faction?.name), stat(value.estimatedStats),
      text(value.estimateSource), unixDate(value.estimateUpdatedAt), text(value.reason).trim() || text(value.notes).trim(),
      text(value.status?.state), text(value.status?.description), unixDate(value.status?.until), stringDate(value.checkedAt),
      unixDate(value.lastAction), typeof value.reserved === 'boolean' ? String(value.reserved) : '',
      stringDate(value.reservationExpiresAt), playerId ? `https://www.torn.com/profiles.php?XID=${playerId}` : '',
      playerId ? `https://www.torn.com/page.php?sid=attack&user2ID=${playerId}` : ''];
  }
  function csvCell(value) {
    let safe = String(value);
    // Quotes alone do not prevent spreadsheets from evaluating a text cell.
    if (typeof value === 'string' && (/^[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]*[=+\-@]/u.test(safe)
        || /^[\t\r\n]/u.test(safe))) safe = `'${safe}`;
    return `"${safe.replace(/"/g, '""')}"`;
  }
  function markdown(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/[\\`*_{}\[\]()!#|~]/g, '\\$&').replace(/\r\n?|\n/g, '<br>');
  }
  function markdownRow(row) {
    const [playerId, name, factionId, faction, stats, source, updated, reason, status, description,
      until, checked, active, reserved, reservationExpires, profile, attack] = row;
    const playerLabel = `${markdown(name)}${playerId ? `${name ? ' ' : ''}\\[${playerId}\\]` : ''}`;
    const factionLabel = `${markdown(faction)}${factionId ? `${faction ? ' ' : ''}\\[${factionId}\\]` : ''}`;
    const statusLines = [status, description && description !== status ? description : '',
      until ? `Until: ${until}` : '', reserved ? `Reserved by another member: ${reserved}` : '',
      reservationExpires ? `Reservation expires: ${reservationExpires}` : ''].filter(Boolean).map(markdown);
    return [profile ? `[${playerLabel}](${profile})` : playerLabel,
      factionId ? `[${factionLabel}](https://www.torn.com/factions.php?step=profile&ID=${factionId})` : factionLabel,
      markdown(stats), markdown(source), markdown(updated), markdown(reason), statusLines.join('<br>'),
      markdown(checked), markdown(active), attack ? `[Attack](${attack})` : ''];
  }
  function serialize(format, targets, { now = Date.now() } = {}) {
    if (!['csv', 'markdown'].includes(format)) throw new Error('Choose CSV or Markdown for the target list export.');
    if (!Array.isArray(targets)) throw new TypeError('A target list is required to export.');
    const rows = targets.map(record);
    if (format === 'csv') return {
      text: `\ufeff${[csvHeaders, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`,
      mime: 'text/csv;charset=utf-8', extension: 'csv',
    };
    const table = [markdownHeaders, markdownHeaders.map(() => '---'), ...rows.map(markdownRow)]
      .map(row => `| ${row.join(' | ')} |`).join('\n');
    return {
      text: `# NWA target list\n\nExported at: ${date(now) || 'Unknown'}\n\nTargets: ${rows.length}\n\n${table}\n`,
      mime: 'text/markdown;charset=utf-8', extension: 'md',
    };
  }
  return { serialize };
})();
