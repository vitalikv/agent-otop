import type { DialogState } from './chat.js';

export const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function isDialogState(value: unknown): value is DialogState {
  if (!isRecord(value) || value.version !== 1 || value.intent !== 'hydraulics.flow' || !isRecord(value.parameters)) return false;
  if (Object.keys(value).some(key => !['version', 'intent', 'parameters', 'pending'].includes(key))) return false;
  if (value.pending !== undefined && !['load_kw', 'coolant', 'temperature', 'method'].includes(String(value.pending))) return false;
  const numeric = ['load_kw', 'supply_c', 'return_c', 'water_delta_k', 'specific_heat_j_kg_k', 'density_kg_m3', 'properties_temperature_c', 'previous_delta_k'];
  return Object.entries(value.parameters).every(([key, field]) => {
    if (numeric.includes(key)) return typeof field === 'number' && Number.isFinite(field);
    if (key === 'coolant') return ['water', 'glycol', 'other'].includes(String(field)) && typeof field === 'string';
    if (key === 'method') return ['water_approximation', 'fluid_properties', 'delta_ratio'].includes(String(field)) && typeof field === 'string';
    if (key === 'unchanged_load_and_properties') return typeof field === 'boolean';
    return ['properties_source', 'properties_composition'].includes(key) && typeof field === 'string' && field.length > 0 && field.length <= 1000;
  });
}
