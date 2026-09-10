import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { readWearableResult } from '../components/wearables/WearableCompanionHost';

export default function WearableResultScreen() {
  const { resultId } = useLocalSearchParams<{ resultId?: string }>();
  const [result, setResult] = useState<any>(null);
  useEffect(() => { if (resultId) void readWearableResult(resultId).then(setResult); }, [resultId]);
  return <SafeAreaView style={styles.root}><ScrollView contentContainerStyle={styles.content}>
    <Pressable onPress={() => router.back()}><Text style={styles.back}>‹ BACK</Text></Pressable>
    <Text style={styles.eyebrow}>OPENED FROM GOOGLE XR</Text><Text style={styles.title}>Scan Result</Text>
    <Text style={styles.summary}>{result?.summary ?? 'This result is no longer available.'}</Text>
    {(result?.products ?? []).map((product: any, index: number) => <View key={`${product.title}-${index}`} style={styles.card}>
      <Text style={styles.product}>{product.title}</Text><Text style={styles.meta}>{product.brand} · {product.price} {product.currency}</Text>
    </View>)}
  </ScrollView></SafeAreaView>;
}
const styles = StyleSheet.create({ root:{flex:1,backgroundColor:'#050509'},content:{padding:24,gap:16},back:{color:'#00E5FF',fontWeight:'800'},eyebrow:{color:'#8B5CF6',letterSpacing:2,fontSize:11,marginTop:20},title:{color:'#FFF',fontSize:34,fontWeight:'800'},summary:{color:'#D7D9E2',fontSize:18,lineHeight:26},card:{backgroundColor:'#10101A',borderRadius:16,padding:16,borderWidth:1,borderColor:'#2F2450'},product:{color:'#FFF',fontWeight:'700',fontSize:17},meta:{color:'#9EA1AF',marginTop:6} });
