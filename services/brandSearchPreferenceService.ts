import { supabase } from './supabaseClient';

async function actor(expected: string): Promise<string> {
  const { data } = await supabase.auth.getSession();
  if (!expected || data.session?.user.id !== expected) throw new Error('Your account changed. Please try again.');
  return expected;
}

export async function fetchBrandSearchPreference(expected: string): Promise<boolean> {
  const userId = await actor(expected);
  const { data, error } = await supabase.from('user_stylist_preferences')
    .select('include_black_owned_brand_search').eq('user_id', userId).maybeSingle();
  if (error) throw new Error('Could not load shopping discovery settings.');
  await actor(expected);
  return data?.include_black_owned_brand_search === true;
}

export async function saveBrandSearchPreference(expected: string, value: boolean): Promise<boolean> {
  if (typeof value !== 'boolean') throw new Error('Choose an on or off setting.');
  const userId = await actor(expected);
  const { data, error } = await supabase.from('user_stylist_preferences')
    .upsert({ user_id: userId, include_black_owned_brand_search: value }, { onConflict: 'user_id' })
    .select('include_black_owned_brand_search').single();
  if (error || data?.include_black_owned_brand_search !== value) throw new Error('Could not save shopping discovery settings.');
  await actor(expected);
  return value;
}
