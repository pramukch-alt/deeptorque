// Reusable BLE Service for Smart Torque Device
// Location: services/bluetoothService.ts

export type BLEConnectionStatus = 'disconnected' | 'connecting' | 'connected';

export interface BLEDataCallback {
  (torque: number, rawMessage: string, timestamp: Date): void;
}

export interface BLEStatusCallback {
  (status: BLEConnectionStatus, deviceName?: string, error?: string): void;
}

export class BluetoothService {
  private device: BluetoothDevice | null = null;
  private characteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private status: BLEConnectionStatus = 'disconnected';
  private deviceName: string = '';
  
  // Specific BLE Device details
  public readonly SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
  public readonly CHARACTERISTIC_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
  public readonly DEVICE_NAME_PREFIX = 'Smart_To'; // Filters 'Smart_To' or 'Smart_Torque'
  
  private onDataCallback: BLEDataCallback | null = null;
  private onStatusCallback: BLEStatusCallback | null = null;

  constructor() {
    this.handleDisconnection = this.handleDisconnection.bind(this);
    this.handleNotification = this.handleNotification.bind(this);
  }

  /**
   * Scans and connects to the BLE Smart Torque wrench device.
   * @param onDataReceived callback triggered when a new torque notification arrives.
   * @param onStatusChanged callback triggered when BLE connection state updates.
   */
  public async connect(
    onDataReceived: BLEDataCallback,
    onStatusChanged: BLEStatusCallback
  ): Promise<void> {
    this.onDataCallback = onDataReceived;
    this.onStatusCallback = onStatusChanged;

    if (!navigator.bluetooth) {
      const errorMsg = 'Web Bluetooth API is not supported in this browser/OS.';
      this.updateStatus('disconnected', '', errorMsg);
      throw new Error(errorMsg);
    }

    try {
      this.updateStatus('connecting');
      console.log('Scanning for BLE Smart Torque device...');

      // Request device with name filter and service UUID
      this.device = await navigator.bluetooth.requestDevice({
        filters: [
          { namePrefix: this.DEVICE_NAME_PREFIX },
          { services: [this.SERVICE_UUID] }
        ],
        optionalServices: [this.SERVICE_UUID]
      });

      this.deviceName = this.device.name || 'Smart Torque Device';
      console.log(`Device selected: ${this.deviceName}. Connecting to GATT...`);
      
      // Monitor disconnections
      this.device.addEventListener('gattserverdisconnected', this.handleDisconnection);

      // Connect GATT Server
      const server = await this.device.gatt?.connect();
      if (!server) {
        throw new Error('Failed to connect to GATT server.');
      }

      console.log('GATT Server connected. Getting service...');
      const service = await server.getPrimaryService(this.SERVICE_UUID);

      console.log('Service obtained. Getting characteristic...');
      this.characteristic = await service.getCharacteristic(this.CHARACTERISTIC_UUID);

      // Subscribe to Notifications
      console.log('Starting notifications...');
      await this.characteristic.startNotifications();
      this.characteristic.addEventListener('characteristicvaluechanged', this.handleNotification);

      console.log('BLE Connection established successfully.');
      this.updateStatus('connected', this.deviceName);

    } catch (err: any) {
      console.error('BLE connection failed:', err);
      this.cleanup();
      this.updateStatus('disconnected', '', err.message || 'Connection cancelled.');
      throw err;
    }
  }

  /**
   * Disconnects the BLE device.
   */
  public disconnect(): void {
    console.log('Disconnecting BLE Smart Torque Wrench manually...');
    this.cleanup();
    this.updateStatus('disconnected');
  }

  /**
   * Parses torque float value from raw UTF-8 string payload.
   * Example string: "Torque: 6.5 Nm" or "Torque: 45.8 Nm"
   * @param payload Raw string notification
   */
  public parseTorque(payload: string): number | null {
    // Regex matches "Torque: X.X Nm" or extracts the first decimal number in the payload
    const match = payload.match(/Torque:\s*([0-9.]+)\s*Nm/i) || payload.match(/([0-9.]+)/);
    if (match) {
      const val = parseFloat(match[1]);
      return isNaN(val) ? null : val;
    }
    return null;
  }

  /**
   * Reads the current connection status.
   */
  public getConnectionStatus(): BLEConnectionStatus {
    return this.status;
  }

  /**
   * Handles incoming notification values.
   */
  private handleNotification(event: any): void {
    const value: DataView = event.target.value;
    try {
      // Decode UTF-8 string from the raw buffer
      const decoder = new TextDecoder('utf-8');
      const rawString = decoder.decode(value);
      console.log('Raw BLE notification payload received:', rawString);
      
      const parsedTorque = this.parseTorque(rawString);
      
      if (parsedTorque !== null && this.onDataCallback) {
        this.onDataCallback(parsedTorque, rawString, new Date());
      }
    } catch (err) {
      console.error('Error decoding BLE payload:', err);
    }
  }

  /**
   * Handles unexpected BLE disconnections.
   */
  private handleDisconnection(): void {
    console.warn('BLE device disconnected unexpectedly.');
    this.cleanup();
    this.updateStatus('disconnected', '', 'Device disconnected unexpectedly.');
  }

  /**
   * Updates state and notifies listener callback.
   */
  private updateStatus(status: BLEConnectionStatus, deviceName: string = '', error: string = ''): void {
    this.status = status;
    if (this.onStatusCallback) {
      this.onStatusCallback(status, deviceName, error);
    }
  }

  /**
   * Cleans up all connections and event listeners.
   */
  private cleanup(): void {
    if (this.characteristic) {
      try {
        this.characteristic.removeEventListener('characteristicvaluechanged', this.handleNotification);
      } catch (e) {
        console.warn('Error removing char listener:', e);
      }
      this.characteristic = null;
    }
    
    if (this.device) {
      this.device.removeEventListener('gattserverdisconnected', this.handleDisconnection);
      if (this.device.gatt?.connected) {
        this.device.gatt.disconnect();
      }
      this.device = null;
    }
    this.deviceName = '';
  }
}
