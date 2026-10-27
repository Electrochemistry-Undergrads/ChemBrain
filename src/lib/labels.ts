export type Tone = 'good' | 'warn' | 'bad' | 'neutral' | 'info';

export const ACCESS: Record<string, [string, Tone, string]> = {
  unknown: ['Access unknown', 'neutral', 'ChemBrain has not confirmed whether you can read this paper.'],
  open_access: ['Open access', 'good', 'The paper is published under an open licence.'],
  entitled: ['Access confirmed', 'good', 'The publisher confirmed your access through your connection.'],
  user_confirmed: ['You can read it', 'good', 'You confirmed you can read this paper (for example through your library).'],
  not_entitled: ['No access', 'bad', 'The publisher reports that your credentials do not cover this paper.'],
};

export const RETRIEVAL: Record<string, [string, Tone, string]> = {
  discovered: ['Not downloaded', 'neutral', 'Found in search; retrieval has not been attempted.'],
  abstract_only: ['Summary only', 'warn', 'Only the abstract was available. Abstracts are not counted as full papers.'],
  full_text_retrieved: ['Downloaded', 'good', 'The complete article was retrieved and its identity verified.'],
  institutional_connection_required: ['Campus access needed', 'warn', 'Your subscription is tied to your campus network or library token, which ChemBrain’s cloud servers do not have.'],
  permission_required: ['Access needed', 'warn', 'Credentials, entitlement, or a publisher agreement is missing.'],
  retrieval_failed: ['Download failed', 'bad', 'A technical failure or no available source. See the attempt log.'],
};

export const PARSE: Record<string, [string, Tone, string]> = {
  not_parsed: ['Text not ready', 'neutral', ''],
  parsed: ['Text ready', 'good', 'The complete document was split into sections and chunks.'],
  parsing_incomplete: ['Partial text', 'warn', 'Only part of the article body could be read.'],
  unreadable: ['Unreadable', 'bad', 'No text layer (likely scanned). OCR is not performed.'],
};

export const AI: Record<string, [string, Tone, string]> = {
  open_license: ['AI allowed', 'good', 'The open licence permits this processing.'],
  user_attested: ['AI allowed', 'good', 'You confirmed your agreement permits analysis with Meta.'],
  not_confirmed: ['AI permission needed', 'warn', 'Subscription access alone does not establish permission to send content to an external AI service. Confirm it in Connections or when uploading.'],
};

export const ANALYSIS: Record<string, [string, Tone, string]> = {
  not_started: ['Not analysed', 'neutral', ''],
  in_progress: ['Analysing', 'info', ''],
  partial: ['Partially analysed', 'warn', 'Some document windows failed; results may be incomplete.'],
  analysis_complete: ['Analyzed', 'good', 'Every chunk of the retrieved document was processed.'],
  failed: ['Analysis failed', 'bad', ''],
};

export const CATEGORY: Record<string, string> = {
  objective: 'Objective',
  material: 'Material studied',
  ingredient: 'Ingredient',
  equipment: 'Equipment',
  method_step: 'Method step',
  condition: 'Condition',
  characterization: 'Testing',
  result: 'Result',
  hazard: 'Hazard',
  limitation: 'Limitation',
  unsuccessful_approach: 'Unsuccessful approach',
};

export const CHECK: Record<string, [string, Tone]> = {
  supported: ['Supported', 'good'],
  partially_supported: ['Partly supported', 'warn'],
  unsupported: ['Not supported', 'bad'],
  unchecked: ['Unchecked', 'neutral'],
};

export const PROVIDER_NAME: Record<string, string> = { elsevier: 'Elsevier', wiley: 'Wiley', springer: 'Springer Nature' };

export const CONNECTOR_NAME: Record<string, string> = {
  elsevier: 'Elsevier Article Retrieval API',
  wiley: 'Wiley TDM API',
  springer_oa: 'Springer Nature Open Access API',
  springer_fulltext: 'Springer Nature Full Text API',
  europepmc: 'Europe PMC (open access)',
  demo_bundle: 'Demonstration bundle',
  user_upload: 'Your upload',
  user_upload_attested: 'Your upload',
  validation: 'Document checks',
};
