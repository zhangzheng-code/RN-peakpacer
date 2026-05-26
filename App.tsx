/**
 * SmartHike - 智慧户外徒步应用入口
 *
 * 导入 global.css 以激活 NativeWind 的 Tailwind CSS 样式系统。
 * NativeWind v4 通过 babel 插件将 className 属性转换为 React Native StyleSheet，
 * global.css 是整个样式系统的入口文件。
 */
import './global.css';

import { StatusBar } from 'expo-status-bar';
import { StyleSheet, View } from 'react-native';
import MapContainer from './src/components/MapContainer';

export default function App() {
  return (
    <View style={styles.container}>
      <StatusBar style="auto" />
      <MapContainer />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#fff',
  },
});
