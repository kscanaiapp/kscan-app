import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { ProductCard } from '../luxury/ProductCard';
import type { SecondaryProduct } from '../../services/blackOwnedDiscovery';
type SandboxProduct = Omit<SecondaryProduct,'placementType'> & { placementType:'sponsored'; disclosure:'Sponsored'; previewOnly:true };
export type SponsorshipSandboxResponse = {
  version:'sponsorship-sandbox-v1';sandbox:true;status:'ready'|'empty'|'unavailable';products:SandboxProduct[];
  disclosureTemplate:{label:'Sponsored';explanation:string};generatedAt:string;
};
/** Internal demo component only, never mounted in customer routes. Access must
 * also pass the sandbox endpoint's staff and environment checks. No purchase,
 * save or checkout handoff is performed against synthetic inventory. */
export function SponsorshipSandboxShelf({ response, staffSessionVerified = false }: { response?: SponsorshipSandboxResponse; staffSessionVerified?: boolean }) {
  if (!staffSessionVerified || response?.sandbox !== true || response.version !== 'sponsorship-sandbox-v1' || response.status !== 'ready') return null;
  const products = response.products.filter(p=>p.placementType==='sponsored'&&p.previewOnly===true&&p.disclosure==='Sponsored');
  if (!products.length) return null;
  return <View testID="sponsorship-sandbox-preview">
    <Text accessibilityRole="header">Sponsorship preview · Sandbox</Text>
    <Text>Demonstration only. These placements are not live commerce.</Text>
    <ScrollView horizontal>{products.map(product=><ProductCard key={product.id} title={product.title} subtitle={product.brandName}
      imageUrl={product.imageUrl} price={product.price} ownershipIdentity={product.ownershipIdentity}
      sponsoredDisclosure={{label:product.disclosure,sandbox:true}}
      accessibilityLabel={`${product.title}. Sponsored. Sandbox demonstration.`} />)}</ScrollView>
  </View>;
}
