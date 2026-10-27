/** Names and aliases for searching and categorizing instruments explicitly reported in results. */
export const INSTRUMENT_GROUPS = [
  'Preparation', 'Heating & pressure', 'Atmosphere & deposition',
  'Imaging & structure', 'Chemical analysis', 'Property testing',
] as const;
export type InstrumentGroup = typeof INSTRUMENT_GROUPS[number];

export const INSTRUMENTS = [
  { id: 'centrifuge', name: 'Centrifuge', group: 'Preparation', aliases: ['centrifugation'] },
  { id: 'sonicator', name: 'Ultrasonicator', group: 'Preparation', aliases: ['sonicator', 'sonication', 'ultrasonic bath', 'ultrasonic probe'] },
  { id: 'ball-mill', name: 'Ball mill', group: 'Preparation', aliases: ['ball milling', 'planetary mill', 'mechanochemical mill'] },
  { id: 'freeze-dryer', name: 'Freeze dryer', group: 'Preparation', aliases: ['lyophilizer', 'lyophilisation', 'lyophilization', 'freeze drying'] },
  { id: 'rotary-evaporator', name: 'Rotary evaporator', group: 'Preparation', aliases: ['rotavap', 'rotovap'] },
  { id: 'electrospinner', name: 'Electrospinning setup', group: 'Preparation', aliases: ['electrospinner', 'electrospinning'] },
  { id: 'spin-coater', name: 'Spin coater', group: 'Preparation', aliases: ['spin coating'] },
  { id: 'furnace', name: 'Muffle furnace', group: 'Heating & pressure', aliases: ['muffle oven'] },
  { id: 'tube-furnace', name: 'Tube furnace', group: 'Heating & pressure', aliases: ['tubular furnace'] },
  { id: 'autoclave', name: 'Hydrothermal / pressure reactor', group: 'Heating & pressure', aliases: ['autoclave', 'hydrothermal reactor', 'solvothermal reactor', 'pressure vessel'] },
  { id: 'microwave-reactor', name: 'Microwave reactor', group: 'Heating & pressure', aliases: ['microwave synthesis'] },
  { id: 'vacuum-oven', name: 'Vacuum oven', group: 'Heating & pressure', aliases: ['vacuum drying oven'] },
  { id: 'glovebox', name: 'Glovebox', group: 'Atmosphere & deposition', aliases: ['glove box'] },
  { id: 'schlenk-line', name: 'Schlenk line', group: 'Atmosphere & deposition', aliases: ['vacuum gas manifold', 'schlenk manifold'] },
  { id: 'cvd', name: 'Chemical vapour deposition (CVD)', group: 'Atmosphere & deposition', aliases: ['cvd reactor', 'chemical vapor deposition', 'cvd'] },
  { id: 'sputterer', name: 'Sputter deposition system', group: 'Atmosphere & deposition', aliases: ['sputtering', 'sputter coater', 'magnetron'] },
  { id: 'xrd', name: 'X-ray diffractometer (XRD)', group: 'Imaging & structure', aliases: ['xrd', 'x ray diffraction', 'xray diffraction'] },
  { id: 'sem', name: 'Scanning electron microscope (SEM)', group: 'Imaging & structure', aliases: ['sem', 'fe sem', 'fesem', 'scanning electron microscopy'] },
  { id: 'tem', name: 'Transmission electron microscope (TEM)', group: 'Imaging & structure', aliases: ['tem', 'hrtem', 'transmission electron microscopy'] },
  { id: 'afm', name: 'Atomic force microscope (AFM)', group: 'Imaging & structure', aliases: ['afm', 'atomic force microscopy'] },
  { id: 'ftir', name: 'FTIR spectrometer', group: 'Chemical analysis', aliases: ['ftir', 'ft ir', 'fourier transform infrared', 'infrared spectrometer'] },
  { id: 'raman', name: 'Raman spectrometer', group: 'Chemical analysis', aliases: ['raman spectroscopy', 'raman'] },
  { id: 'uv-vis', name: 'UV–Vis spectrophotometer', group: 'Chemical analysis', aliases: ['uv vis', 'uv visible', 'ultraviolet visible'] },
  { id: 'nmr', name: 'NMR spectrometer', group: 'Chemical analysis', aliases: ['nmr', 'nuclear magnetic resonance'] },
  { id: 'xps', name: 'X-ray photoelectron spectrometer (XPS)', group: 'Chemical analysis', aliases: ['xps', 'x ray photoelectron spectroscopy'] },
  { id: 'hplc', name: 'Liquid chromatograph (HPLC)', group: 'Chemical analysis', aliases: ['hplc', 'high performance liquid chromatography'] },
  { id: 'gc-ms', name: 'Gas chromatograph–mass spectrometer (GC–MS)', group: 'Chemical analysis', aliases: ['gc ms', 'gas chromatography mass spectrometry'] },
  { id: 'bet', name: 'Surface area analyser (BET)', group: 'Property testing', aliases: ['bet', 'surface area analyzer', 'gas adsorption analyser', 'gas adsorption analyzer'] },
  { id: 'tga', name: 'Thermogravimetric analyser (TGA)', group: 'Property testing', aliases: ['tga', 'thermogravimetric analysis', 'thermogravimetric analyzer'] },
  { id: 'dsc', name: 'Differential scanning calorimeter (DSC)', group: 'Property testing', aliases: ['dsc', 'differential scanning calorimetry'] },
  { id: 'mechanical-tester', name: 'Universal / tensile testing machine', group: 'Property testing', aliases: ['universal testing machine', 'tensile tester', 'mechanical tester'] },
  { id: 'potentiostat', name: 'Potentiostat / galvanostat', group: 'Property testing', aliases: ['potentiostat', 'galvanostat', 'electrochemical workstation'] },
] as const satisfies readonly { id: string; name: string; group: InstrumentGroup; aliases: readonly string[] }[];

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Whole phrases prevent short aliases such as SEM from matching unrelated words. */
export function instrumentsIn(text: string) {
  const haystack = ` ${normalize(text)} `;
  return INSTRUMENTS.filter((i) => [i.name, i.name.replace(/\s*\([^)]*\)/g, ''), ...i.aliases].some((s) => haystack.includes(` ${normalize(s)} `)));
}
