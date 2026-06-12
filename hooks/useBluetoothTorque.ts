// React Hook for BLE Smart Torque Wrench
// Location: hooks/useBluetoothTorque.ts

import { useState, useEffect, useRef, useCallback } from 'react';
import { BluetoothService, BLEConnectionStatus } from '../services/bluetoothService';

export interface UseBluetoothTorqueResult {
  status: BLEConnectionStatus;
  deviceName: string;
  measuredTorque: number | null;
  lastRawMessage: string;
  lastTimestamp: string | null;
  error: string;
  connectDevice: () => Promise<void>;
  disconnectDevice: () => void;
  clearMeasurements: () => void;
}

export function useBluetoothTorque(): UseBluetoothTorqueResult {
  const [status, setStatus] = useState<BLEConnectionStatus>('disconnected');
  const [deviceName, setDeviceName] = useState<string>('');
  const [measuredTorque, setMeasuredTorque] = useState<number | null>(null);
  const [lastRawMessage, setLastRawMessage] = useState<string>('');
  const [lastTimestamp, setLastTimestamp] = useState<string | null>(null);
  const [error, setError] = useState<string>('');

  // Persist the BLE service instance across renders using useRef
  const bleServiceRef = useRef<BluetoothService | null>(null);

  // Initialize the Bluetooth Service
  if (!bleServiceRef.current) {
    bleServiceRef.current = new BluetoothService();
  }

  // Clear states
  const clearMeasurements = useCallback(() => {
    setMeasuredTorque(null);
    setLastRawMessage('');
    setLastTimestamp(null);
  }, []);

  // Connect handler
  const connectDevice = useCallback(async () => {
    setError('');
    
    const handleData = (torque: number, raw: string, timestamp: Date) => {
      setMeasuredTorque(torque);
      setLastRawMessage(raw);
      setLastTimestamp(
        timestamp.toLocaleDateString() + ' ' + timestamp.toLocaleTimeString()
      );
    };

    const handleStatus = (
      newStatus: BLEConnectionStatus,
      devName?: string,
      errMsg?: string
    ) => {
      setStatus(newStatus);
      if (devName) setDeviceName(devName);
      if (errMsg) setError(errMsg);
    };

    try {
      await bleServiceRef.current?.connect(handleData, handleStatus);
    } catch (err: any) {
      console.warn('Hook caught BLE connection error:', err);
      // Status update is already handled by the service callback
    }
  }, []);

  // Disconnect handler
  const disconnectDevice = useCallback(() => {
    bleServiceRef.current?.disconnect();
    setStatus('disconnected');
    setDeviceName('');
  }, []);

  // Auto-cleanup on React component unmount
  useEffect(() => {
    return () => {
      if (bleServiceRef.current) {
        bleServiceRef.current.disconnect();
      }
    };
  }, []);

  return {
    status,
    deviceName,
    measuredTorque,
    lastRawMessage,
    lastTimestamp,
    error,
    connectDevice,
    disconnectDevice,
    clearMeasurements
  };
}
