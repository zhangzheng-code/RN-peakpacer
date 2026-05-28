import './global.css';

import React from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';

import ExploreScreen from './src/screens/ExploreScreen';
import AIGuideScreen from './src/screens/AIGuideScreen';
import HikeGoScreen from './src/screens/HikeGoScreen';
import PartnerScreen from './src/screens/PartnerScreen';
import FootprintsScreen from './src/screens/FootprintsScreen';
import CustomCurvedTabBar from './src/components/CustomCurvedTabBar';

const Tab = createBottomTabNavigator();

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <NavigationContainer>
        <Tab.Navigator
          tabBar={(props) => <CustomCurvedTabBar {...props} />}
          screenOptions={{
            headerShown: false,
          }}
          sceneContainerStyle={{ backgroundColor: '#121314' }}
        >
          <Tab.Screen name="Explore" component={ExploreScreen} />
          <Tab.Screen name="AIGuide" component={AIGuideScreen} />
          <Tab.Screen
            name="HikeGo"
            component={HikeGoScreen}
            options={{ lazy: false }}
          />
          <Tab.Screen name="Partner" component={PartnerScreen} />
          <Tab.Screen name="Footprints" component={FootprintsScreen} />
        </Tab.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
