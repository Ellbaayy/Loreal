export interface Perfume {
  id: number;
  brand: string;
  name: string;
  image_url: string | null;
  scent_family: string | null;
  best_occasion: string | null;
  mood: string | null;
  top_notes: string | null;
  middle_notes: string | null;
  base_notes: string | null;
  longevity: string | null;
}

export interface ChatSession {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface ChatMessage {
  id: number;
  session_id: number;
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface AiRecommendation {
  id: number;
  reason?: string;
  detailed_analysis?: string;
  who_is_it_for?: string;
  popularity_score?: number;
  niche_score?: number;
  projection?: string;
  odor_safe?: boolean;
  odor_safe_reason?: string;
}

export interface AiResponse {
  text: string;
  ready: boolean;
  recommendations?: AiRecommendation[];
}

const HARDCODED: Perfume[] = [
  { id: 1, brand: 'Dior', name: 'Sauvage', image_url: null, scent_family: 'Woody Aromatic', best_occasion: 'Work', mood: 'Confident', top_notes: 'Bergamot, Pepper', middle_notes: 'Lavender, Sichuan Pepper', base_notes: 'Ambroxan, Cedar', longevity: '8-10 Hours' },
  { id: 2, brand: 'YSL', name: 'Libre', image_url: null, scent_family: 'Floral Woody', best_occasion: 'Date', mood: 'Bold', top_notes: 'Lavender, Mandarin', middle_notes: 'Orange Blossom, Jasmine', base_notes: 'Vanilla, Musk', longevity: '10-12 Hours' },
  { id: 3, brand: 'Maison Margiela', name: 'Lazy Sunday Morning', image_url: null, scent_family: 'Floral Aldehydic', best_occasion: 'Casual', mood: 'Calm', top_notes: 'Aldehydes, Pear', middle_notes: 'Iris, Rose', base_notes: 'White Musk, Patchouli', longevity: '6-8 Hours' },
];

export async function getPerfumeDatabase(): Promise<Perfume[]> {
  const { query } = await import('./db');
  const rows = await query<Perfume>('SELECT * FROM perfumes ORDER BY id DESC');
  if (rows.length > 0) return rows;
  return HARDCODED;
}
