const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

const DEFAULT_CAPACITY = 25;
const CSV_PATH = path.join(__dirname, '../../svod.csv');

const NAME_HEADER = 'Название активности';
const DESC_HEADER = 'Описание в формате рекламного объявления';

function trimCell(c) {
  return String(c == null ? '' : c).trim();
}

function loadFromCsv() {
  if (!fs.existsSync(CSV_PATH)) return null;
  const raw = fs.readFileSync(CSV_PATH, 'utf8');
  let rows;
  try {
    rows = parse(raw, {
      relax_column_count: true,
      trim: true,
      skip_empty_lines: false,
      bom: true,
    });
  } catch (e) {
    console.warn('Failed to parse svod.csv:', e.message);
    return null;
  }
  const headerRowIndex = rows.findIndex((r) =>
    r.some((c) => trimCell(c).includes(NAME_HEADER))
  );
  if (headerRowIndex === -1) return null;

  const header = rows[headerRowIndex];
  const nameCol = header.findIndex((c) => trimCell(c).includes(NAME_HEADER));
  const descCol = header.findIndex((c) =>
    trimCell(c).includes('Описание в формате рекламного объявления')
  );
  if (nameCol === -1) return null;

  const dataRows = rows.slice(headerRowIndex + 1);
  const list = [];
  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const name = trimCell(row[nameCol] || '');
    if (!name) continue;
    const description = descCol >= 0 ? trimCell(row[descCol] || '') : '';
    list.push({
      id: `d${list.length + 1}`,
      name,
      description: description || undefined,
      capacity: DEFAULT_CAPACITY,
    });
  }
  return list.length ? list : null;
}

const DEFAULT_LIST = [
  { id: 'd1', name: 'Art & Crafts', capacity: 25 }
];

/** Used to seed data/departments.json on first run (from CSV or default). */
function getInitialDepartments() {
  return loadFromCsv() || DEFAULT_LIST;
}

module.exports = { DEPARTMENTS: getInitialDepartments(), getInitialDepartments, loadFromCsv };
