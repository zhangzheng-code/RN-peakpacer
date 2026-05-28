import React from 'react';
import { View } from 'react-native';
import MapContainer from '../components/MapContainer';

export default function HikeGoScreen() {
  return (
    <View className="flex-1 bg-[#121314]">
      <MapContainer />
    </View>
  );
}
