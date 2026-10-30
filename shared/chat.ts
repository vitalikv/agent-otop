export interface FlowInput {
  method?: 'water_approximation' | 'fluid_properties' | 'delta_ratio';
  load_kw?: number;
  coolant?: 'water' | 'glycol' | 'other';
  supply_c?: number;
  return_c?: number;
  water_delta_k?: number;
  specific_heat_j_kg_k?: number;
  density_kg_m3?: number;
  properties_source?: string;
  properties_temperature_c?: number;
  properties_composition?: string;
  previous_delta_k?: number;
  unchanged_load_and_properties?: boolean;
}

export type PendingField = 'load_kw' | 'coolant' | 'temperature' | 'method';
export interface DialogState {
  version: 1;
  intent: 'hydraulics.flow';
  parameters: FlowInput;
  pending?: PendingField;
}

export interface AnswerSource {
  id: string;
  title: string;
  href: string;
}

export interface ChatAnswer {
  content: string;
  sources: AnswerSource[];
  choices: string[];
  clarification: boolean;
  state?: DialogState;
  calculation?: { status: string; values: Record<string, number> };
}

export interface ChatRequest {
  messages: { role: 'user' | 'assistant'; content: string }[];
  state?: DialogState;
}
