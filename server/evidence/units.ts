/**
 * Unit normalisation for comparison. Conversions are only applied to unambiguous units; the
 * original value and unit are always preserved alongside. Bare "%" is never converted because it
 * may mean wt%, v/v, mol%, relative humidity, or elongation.
 */

interface UnitDef {
  dim: string;
  canonical: string;
  factor: number;
  offset?: number;
}

const U: Record<string, UnitDef> = {};
const def = (names: string[], d: UnitDef) => names.forEach((n) => (U[n.toLowerCase()] = d));

def(['°c', 'ºc', 'degc', 'deg c', 'c°', '℃'], { dim: 'temperature', canonical: '°C', factor: 1 });
def(['k', 'kelvin'], { dim: 'temperature', canonical: '°C', factor: 1, offset: -273.15 });
def(['°f', 'ºf', 'degf'], { dim: 'temperature', canonical: '°C', factor: 5 / 9, offset: (-32 * 5) / 9 });
def(['s', 'sec', 'second', 'seconds'], { dim: 'time', canonical: 'min', factor: 1 / 60 });
def(['min', 'mins', 'minute', 'minutes'], { dim: 'time', canonical: 'min', factor: 1 });
def(['h', 'hr', 'hrs', 'hour', 'hours'], { dim: 'time', canonical: 'min', factor: 60 });
def(['d', 'day', 'days'], { dim: 'time', canonical: 'min', factor: 1440 });
def(['pa'], { dim: 'pressure', canonical: 'kPa', factor: 0.001 });
def(['kpa'], { dim: 'pressure', canonical: 'kPa', factor: 1 });
def(['bar'], { dim: 'pressure', canonical: 'kPa', factor: 100 });
def(['mbar'], { dim: 'pressure', canonical: 'kPa', factor: 0.1 });
def(['atm'], { dim: 'pressure', canonical: 'kPa', factor: 101.325 });
def(['psi'], { dim: 'pressure', canonical: 'kPa', factor: 6.894757 });
def(['torr', 'mmhg'], { dim: 'pressure', canonical: 'kPa', factor: 0.1333224 });
def(['mpa'], { dim: 'stress or pressure', canonical: 'MPa', factor: 1 });
def(['gpa'], { dim: 'stress or pressure', canonical: 'MPa', factor: 1000 });
def(['mg'], { dim: 'mass', canonical: 'g', factor: 0.001 });
def(['g'], { dim: 'mass', canonical: 'g', factor: 1 });
def(['kg'], { dim: 'mass', canonical: 'g', factor: 1000 });
def(['μl', 'µl', 'ul'], { dim: 'volume', canonical: 'mL', factor: 0.001 });
def(['ml'], { dim: 'volume', canonical: 'mL', factor: 1 });
def(['l'], { dim: 'volume', canonical: 'mL', factor: 1000 });
def(['mol/l', 'mol l-1', 'mol·l-1', 'mol l⁻¹', 'mol dm-3'], { dim: 'molarity', canonical: 'mol/L', factor: 1 });
def(['mmol/l', 'mmol l-1'], { dim: 'molarity', canonical: 'mol/L', factor: 0.001 });
def(['mg/ml', 'g/l', 'mg ml-1', 'g l-1'], { dim: 'mass concentration', canonical: 'g/L', factor: 1 });
def(['μm', 'µm', 'um', 'micron', 'microns'], { dim: 'length', canonical: 'μm', factor: 1 });
def(['nm'], { dim: 'length', canonical: 'μm', factor: 0.001 });
def(['mm'], { dim: 'length', canonical: 'μm', factor: 1000 });
def(['rpm'], { dim: 'rotation', canonical: 'rpm', factor: 1 });
def(['wt%', 'wt.%', 'wt %', '% w/w', '%w/w', 'w/w%'], { dim: 'mass fraction', canonical: 'wt%', factor: 1 });
def(['°', 'deg', 'degree', 'degrees'], { dim: 'angle', canonical: '°', factor: 1 });

export interface Normalized {
  value: number | null;
  unit: string | null;
  note: string | null;
}

export function normalizeUnit(value: number | null, unit: string | null): Normalized {
  if (value === null || !unit) return { value: null, unit: null, note: null };
  // Case matters for molar units: "M"/"mM" are molar, "mm" is millimetres.
  const CASE: Record<string, UnitDef> = { M: { dim: 'molarity', canonical: 'mol/L', factor: 1 }, mM: { dim: 'molarity', canonical: 'mol/L', factor: 0.001 } };
  const exact = CASE[unit.trim()];
  const key = unit.trim().replace(/\s+/g, ' ').replace(/^per cent$/i, '%').toLowerCase();
  if (key === '%') return { value: null, unit: null, note: 'Bare % is ambiguous (wt%, v/v, RH, elongation…); not converted.' };
  const d = exact ?? U[key];
  if (!d) return { value: null, unit: null, note: null };
  const v = value * d.factor + (d.offset ?? 0);
  const rounded = Math.round(v * 1e6) / 1e6;
  const same = d.factor === 1 && !d.offset;
  return { value: rounded, unit: d.canonical, note: same ? null : `Converted from ${value} ${unit}.` };
}

export function dimensionOf(unit: string | null) {
  if (!unit) return null;
  return U[unit.trim().toLowerCase()]?.dim ?? null;
}
