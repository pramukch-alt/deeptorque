// Torque Inspection System - Application Logic (BLE Integration & Multi-Project)

// Global Application State
const state = {
  db: null,
  projects: [],
  stations: [],
  tables: [],
  activeTab: 'inspect', // 'inspect', 'records', 'settings'
  currentInspector: localStorage.getItem('inspectorName') || 'นายประมุข ชุ่มจันทร์',
  currentProjectId: 'Demo', // Default to Demo project
  currentStationId: null,
  currentTableId: null,
  currentTableType: null, // 'Full' or 'Half'
  currentWrenchSize: 'M12', // Default active Wrench size
  boltsList: [], // Current filtered bolts for the active wrench size
  currentBoltIndex: 0,
  tableRecords: [], // Records already saved for the active table (all sizes)
  
  // Bluetooth Wrench Simulator (legacy mock status)
  bluetoothConnected: false,
  simulatedWrenchActive: false,
  
  // Real BLE Device states
  bleDevice: null,
  bleCharacteristic: null,
  bleStatus: 'disconnected', // 'disconnected', 'connecting', 'connected'
  bleDeviceName: '',
  lastBleRaw: 'N/A',
  lastBleTimestamp: 'N/A',
  
  cameraStream: null
};

// BLE UUID Constants
const BLE_SERVICE_UUID = '4fafc201-1fb5-459e-8fcc-c5c9c331914b';
const BLE_CHARACTERISTIC_UUID = 'beb5483e-36e1-4688-b7f5-ea07361b26a8';
const BLE_DEVICE_NAME_PREFIX = 'Smart_To'; // Filters 'Smart_To' or 'Smart_Torque'

// Bolt Specifications and Quantities from Database information.xlsx
const wrenchSpecs = {
  'M12': { boltSize: 'M12x35', target: 85, min: 70, max: 100, qtyFull: 8, qtyHalf: 4, section: 'Section 1 : Mounting at Pile' },
  'M14': { boltSize: 'M14x80', target: 55, min: 50, max: 60, qtyFull: 4, qtyHalf: 2, section: 'Section 1 : Mounting at Pile' },
  'M10': { boltSize: 'M10x30', target: 50, min: 40, max: 60, qtyFull: 31, qtyHalf: 17, section: 'Section 2 : Sub Rail' },
  'M8':  { boltSize: 'M8x45',  target: 18, min: 16, max: 20, qtyFull: 6, qtyHalf: 5, section: 'Section 3 : PV Module' }
};

// Generate list of bolts for a table based on its type and selected wrench size
function generateBoltsForTable(tableType, wrenchSize) {
  const spec = wrenchSpecs[wrenchSize];
  if (!spec) return [];
  
  const qty = (tableType.toLowerCase() === 'full') ? spec.qtyFull : spec.qtyHalf;
  const list = [];
  for (let i = 1; i <= qty; i++) {
    list.push({
      PositionID: `${wrenchSize}-${i}`,
      BoltPosition: `${spec.section} - ${wrenchSize} Bolt ${i}`,
      BoltSize: spec.boltSize,
      TargetTorque: spec.target,
      MinTorque: spec.min,
      MaxTorque: spec.max
    });
  }
  return list;
}

// Calculate the total bolts for a table across all wrench sizes
function getTotalBoltsForTable(tableType) {
  if (!tableType) return 0;
  let total = 0;
  Object.keys(wrenchSpecs).forEach(size => {
    const spec = wrenchSpecs[size];
    total += (tableType.toLowerCase() === 'full') ? spec.qtyFull : spec.qtyHalf;
  });
  return total;
}

// -------------------------------------------------------------
// 1. INDEXEDDB SETUP & INITIAL SEEDING
// -------------------------------------------------------------
const DB_NAME = 'TorqueInspectionDB';
const DB_VERSION = 3; // Schema version

function initDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = (e) => {
      console.error('Database failed to open:', e);
      reject(e);
    };

    request.onsuccess = (e) => {
      state.db = e.target.result;
      console.log('Database initialized successfully');
      resolve(state.db);
    };

    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      const oldVersion = e.oldVersion;
      console.log(`Database upgrade needed from version ${oldVersion} to ${e.newVersion}`);

      // Reset object stores if upgrading from version 1 or 2 to update keyPaths
      if (oldVersion < 3) {
        console.log('Clearing old object stores for clean database reconstruction...');
        if (db.objectStoreNames.contains('projects')) {
          db.deleteObjectStore('projects');
        }
        if (db.objectStoreNames.contains('stations')) {
          db.deleteObjectStore('stations');
        }
        if (db.objectStoreNames.contains('tables')) {
          db.deleteObjectStore('tables');
        }
        if (db.objectStoreNames.contains('records')) {
          db.deleteObjectStore('records');
        }
        if (db.objectStoreNames.contains('templates')) {
          db.deleteObjectStore('templates');
        }
      }

      // Recreate object stores with new keyPaths and indexes
      db.createObjectStore('projects', { keyPath: 'ProjectID' });

      const stationStore = db.createObjectStore('stations', { keyPath: 'StationID' });
      stationStore.createIndex('ProjectID', 'ProjectID', { unique: false });

      const tableStore = db.createObjectStore('tables', { keyPath: 'TableID' });
      tableStore.createIndex('ProjectID', 'ProjectID', { unique: false });
      tableStore.createIndex('StationID', 'StationID', { unique: false });

      const recordStore = db.createObjectStore('records', { keyPath: 'RecordID', autoIncrement: true });
      recordStore.createIndex('Timestamp', 'Timestamp', { unique: false });
      recordStore.createIndex('TableID', 'TableID', { unique: false });
      recordStore.createIndex('ProjectID', 'ProjectID', { unique: false });
      recordStore.createIndex('StationID', 'StationID', { unique: false });
    };
  });
}

// Seed the database with Projects, Stations, and Tables
async function seedDatabaseIfEmpty() {
  // 1. Check if projects already seeded in a separate readonly transaction
  const checkTx = state.db.transaction('projects', 'readonly');
  const projectStore = checkTx.objectStore('projects');
  
  const projectCount = await new Promise((res, rej) => {
    const req = projectStore.count();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });

  if (projectCount > 0) {
    console.log('Database already contains seeded data.');
    return;
  }

  console.log('Seeding Database information...');

  // 2. Start a fresh readwrite transaction for writing all projects, stations, and tables
  const tx = state.db.transaction(['projects', 'stations', 'tables'], 'readwrite');

  // Seeding Projects
  const defaultProjects = [
    { ProjectID: 'Demo', ProjectName: 'Demo Version Project' },
    { ProjectID: 'SO-SKT10', ProjectName: 'SO-SKT10 Production Project' }
  ];
  defaultProjects.forEach(p => tx.objectStore('projects').put(p));

  // Seeding Stations (8 Stations for both Demo and SO-SKT10)
  const defaultStationsNames = ['TS01-1', 'TS01-2', 'TS02-1', 'TS02-2', 'TS03-1', 'TS03-2', 'TS04-1', 'TS04-2'];
  
  defaultProjects.forEach(proj => {
    defaultStationsNames.forEach(stName => {
      const stationId = `${proj.ProjectID}-${stName}`;
      tx.objectStore('stations').put({
        StationID: stationId,
        ProjectID: proj.ProjectID,
        StationName: stName
      });
    });
  });

  // Seeding Tables
  // 1. For Demo: 10 tables per station (M-001 to M-007 are Full, M-008 to M-010 are Half)
  // 2. For SO-SKT10: 100 tables per station (M-001 to M-092 are Full, M-093 to M-100 are Half)
  defaultProjects.forEach(proj => {
    const isDemo = proj.ProjectID === 'Demo';
    const totalTables = isDemo ? 10 : 100;
    const transitionPoint = isDemo ? 7 : 92; // Tables <= transitionPoint are Full, rest are Half

    defaultStationsNames.forEach(stName => {
      const stationId = `${proj.ProjectID}-${stName}`;
      
      for (let i = 1; i <= totalTables; i++) {
        const tableNumStr = i < 10 ? `00${i}` : (i < 100 ? `0${i}` : `${i}`);
        const tableNum = `M-${tableNumStr}`;
        const tableId = `${stationId}-${tableNum}`;
        const tableType = i <= transitionPoint ? 'Full' : 'Half';

        tx.objectStore('tables').put({
          TableID: tableId,
          ProjectID: proj.ProjectID,
          StationID: stationId,
          TableNumber: tableNum,
          TableType: tableType
        });
      }
    });
  });

  return new Promise((res, rej) => {
    tx.oncomplete = () => {
      console.log('Database seeding successfully completed.');
      res();
    };
    tx.onerror = (err) => {
      console.error('Database seeding failed:', err);
      rej(err);
    };
  });
}

// -------------------------------------------------------------
// 2. DATA UTILITIES (IndexedDB Wrapper helpers)
// -------------------------------------------------------------
function getAllFromStore(storeName) {
  return new Promise((res, rej) => {
    const tx = state.db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const req = store.getAll();
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function getStationsByProject(projectId) {
  return new Promise((res, rej) => {
    const tx = state.db.transaction('stations', 'readonly');
    const store = tx.objectStore('stations');
    const index = store.index('ProjectID');
    const req = index.getAll(projectId);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function getTablesByStation(stationId) {
  return new Promise((res, rej) => {
    const tx = state.db.transaction('tables', 'readonly');
    const store = tx.objectStore('tables');
    const index = store.index('StationID');
    const req = index.getAll(stationId);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function getTableRecords(tableId) {
  return new Promise((res, rej) => {
    const tx = state.db.transaction('records', 'readonly');
    const store = tx.objectStore('records');
    const index = store.index('TableID');
    const req = index.getAll(tableId);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function saveInspectionRecord(record) {
  return new Promise((res, rej) => {
    const tx = state.db.transaction('records', 'readwrite');
    const store = tx.objectStore('records');
    const req = store.add(record);
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function getRecentRecords(limit = 10) {
  return new Promise((res, rej) => {
    const tx = state.db.transaction('records', 'readonly');
    const store = tx.objectStore('records');
    const index = store.index('Timestamp');
    const records = [];
    const req = index.openCursor(null, 'prev');
    
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor && records.length < limit) {
        records.push(cursor.value);
        cursor.continue();
      } else {
        res(records);
      }
    };
    req.onerror = () => rej(req.error);
  });
}

function clearAllRecords() {
  return new Promise((res, rej) => {
    const tx = state.db.transaction('records', 'readwrite');
    const store = tx.objectStore('records');
    const req = store.clear();
    req.onsuccess = () => res();
    req.onerror = () => rej(req.error);
  });
}

// -------------------------------------------------------------
// 3. UI RENDERING AND STATE FLOWS
// -------------------------------------------------------------
async function loadProjectsDropdown() {
  state.projects = await getAllFromStore('projects');
  const projectSelect = document.getElementById('project-select');
  projectSelect.innerHTML = '';
  state.projects.forEach(p => {
    const option = document.createElement('option');
    option.value = p.ProjectID;
    option.textContent = p.ProjectName;
    projectSelect.appendChild(option);
  });
  // Trigger loading initial stations
  if (state.projects.length > 0) {
    handleProjectSelection(state.projects[0].ProjectID);
  }
}

async function handleProjectSelection(projectId) {
  // Check unsaved work
  if (state.currentTableId && isInspectionInProgress()) {
    const confirmLeave = confirm('You have unfinished inspection work on the current table. Switching projects will lose session progress. Continue?');
    if (!confirmLeave) {
      document.getElementById('project-select').value = state.currentProjectId;
      return;
    }
  }

  state.currentProjectId = projectId;
  state.currentStationId = null;
  resetInspectionSection();

  const stations = await getStationsByProject(projectId);
  const stationSelect = document.getElementById('station-select');
  stationSelect.innerHTML = '<option value="">-- Select Station --</option>';
  stations.forEach(st => {
    const option = document.createElement('option');
    option.value = st.StationID;
    option.textContent = st.StationName;
    stationSelect.appendChild(option);
  });

  searchInput.value = '';
  searchInput.disabled = true;
}

// Searchable Table Dropdown Handling
const searchInput = document.getElementById('table-search');
const dropdownMenu = document.getElementById('table-dropdown-menu');

function setupSearchableDropdown() {
  searchInput.addEventListener('focus', () => {
    if (state.currentStationId) {
      filterTableOptions();
      dropdownMenu.classList.add('show');
    }
  });

  searchInput.addEventListener('input', () => {
    filterTableOptions();
    dropdownMenu.classList.add('show');
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-container')) {
      dropdownMenu.classList.remove('show');
    }
  });
}

function filterTableOptions() {
  const query = searchInput.value.toLowerCase();
  dropdownMenu.innerHTML = '';
  
  const filtered = state.tables.filter(t => 
    t.TableNumber.toLowerCase().includes(query) || t.TableID.toLowerCase().includes(query)
  );

  if (filtered.length === 0) {
    dropdownMenu.innerHTML = '<div class="dropdown-item" style="color: var(--text-muted);">No tables found</div>';
    return;
  }

  filtered.forEach(table => {
    const item = document.createElement('div');
    item.className = 'dropdown-item';
    item.textContent = `${table.TableNumber} (${table.TableType === 'Full' ? 'Full' : 'Half'})`;
    item.dataset.id = table.TableID;
    item.addEventListener('click', () => {
      searchInput.value = table.TableNumber;
      dropdownMenu.classList.remove('show');
      handleTableSelection(table.TableID);
    });
    dropdownMenu.appendChild(item);
  });
}

async function handleStationSelection(stationId) {
  // Prevent data loss check
  if (state.currentTableId && isInspectionInProgress()) {
    const confirmLeave = confirm('You have unfinished inspection work on this table. Switching stations will reset session. Continue?');
    if (!confirmLeave) {
      document.getElementById('station-select').value = state.currentStationId;
      return;
    }
  }

  state.currentStationId = stationId;
  searchInput.value = '';
  searchInput.disabled = !stationId;
  
  if (!stationId) {
    state.tables = [];
    resetInspectionSection();
    return;
  }

  state.tables = await getTablesByStation(stationId);
  searchInput.placeholder = "Type Table Number...";
  resetInspectionSection();
}

async function handleTableSelection(tableId) {
  // Prevent data loss check
  if (state.currentTableId && state.currentTableId !== tableId && isInspectionInProgress()) {
    const confirmLeave = confirm('You have unfinished inspection work on the current table. Switch table?');
    if (!confirmLeave) {
      const currentTable = state.tables.find(t => t.TableID === state.currentTableId);
      searchInput.value = currentTable ? currentTable.TableNumber : '';
      return;
    }
  }

  state.currentTableId = tableId;
  const table = state.tables.find(t => t.TableID === tableId);
  if (!table) return;

  state.currentTableType = table.TableType;
  
  // Fetch existing records for this table (across all sizes)
  state.tableRecords = await getTableRecords(tableId);

  // Load the current Wrench specifications & position
  loadWrenchSizeBolts();
}

// Changes active Wrench size and reloads bolts
function handleWrenchSizeChange(size) {
  if (!state.currentTableId) {
    state.currentWrenchSize = size;
    document.querySelectorAll('.wrench-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.size === size);
    });
    document.getElementById('wrench-active-label').textContent = size;
    return;
  }

  const hasInput = document.getElementById('measured-torque').value !== '';
  if (hasInput) {
    const confirmLeave = confirm('You have unsaved torque input. Switch wrench size and discard input?');
    if (!confirmLeave) return;
  }

  state.currentWrenchSize = size;
  
  document.querySelectorAll('.wrench-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.size === size);
  });
  document.getElementById('wrench-active-label').textContent = size;

  loadWrenchSizeBolts();
}

function loadWrenchSizeBolts() {
  if (!state.currentTableId || !state.currentTableType) return;
  
  state.boltsList = generateBoltsForTable(state.currentTableType, state.currentWrenchSize);

  // Filter existing records to find completed bolts of this size
  const wrenchCompletedPositions = state.tableRecords
    .filter(r => r.WrenchSize === state.currentWrenchSize)
    .map(r => r.BoltPosition);

  // Find next incomplete bolt index
  let nextIndex = state.boltsList.findIndex(b => !wrenchCompletedPositions.includes(b.BoltPosition));
  state.currentBoltIndex = nextIndex === -1 ? state.boltsList.length : nextIndex;

  renderInspectionInterface();
}

function isInspectionInProgress() {
  const measuredInput = document.getElementById('measured-torque');
  const hasInput = measuredInput && measuredInput.value !== '';
  
  const completedCount = state.tableRecords.length;
  return hasInput || completedCount > 0;
}

function resetInspectionSection() {
  state.currentTableId = null;
  state.currentTableType = null;
  state.boltsList = [];
  state.currentBoltIndex = 0;
  state.tableRecords = [];
  
  // Reset Spec Display
  document.getElementById('spec-position').textContent = '---';
  document.getElementById('spec-size').textContent = '---';
  document.getElementById('spec-target').textContent = '---';
  document.getElementById('spec-tolerance').textContent = '---';
  document.getElementById('spec-min').textContent = '---';
  document.getElementById('spec-max').textContent = '---';
  
  // Reset Input
  document.getElementById('measured-torque').value = '';
  document.getElementById('measured-torque').disabled = true;
  document.getElementById('btn-submit-result').disabled = true;
  document.getElementById('btn-next-bolt').disabled = true;
  
  // Reset Badge
  const badge = document.getElementById('result-badge');
  badge.textContent = 'PENDING';
  badge.className = 'result-badge';
  
  // Reset Progress Indicators
  document.getElementById('wrench-completed').textContent = '0';
  document.getElementById('wrench-remaining').textContent = '0';
  document.getElementById('wrench-total').textContent = '0';
  document.getElementById('wrench-progress-fill').style.width = '0%';

  document.getElementById('progress-completed').textContent = '0';
  document.getElementById('progress-remaining').textContent = '0';
  document.getElementById('progress-total').textContent = '0';
  document.getElementById('progress-fill').style.width = '0%';
}

function renderInspectionInterface() {
  const isDone = state.currentBoltIndex >= state.boltsList.length;
  const measuredInput = document.getElementById('measured-torque');
  
  // 1. Calculate Wrench Specific Progress
  const wrenchCompleted = state.tableRecords.filter(r => r.WrenchSize === state.currentWrenchSize).length;
  const wrenchTotal = state.boltsList.length;
  const wrenchRemaining = wrenchTotal - wrenchCompleted;
  const wrenchPercent = wrenchTotal > 0 ? (wrenchCompleted / wrenchTotal) * 100 : 0;
  
  document.getElementById('wrench-completed').textContent = wrenchCompleted;
  document.getElementById('wrench-remaining').textContent = wrenchRemaining;
  document.getElementById('wrench-total').textContent = wrenchTotal;
  document.getElementById('wrench-progress-fill').style.width = `${wrenchPercent}%`;

  // 2. Calculate Overall Table Progress
  const totalCompleted = state.tableRecords.length;
  const totalBolts = getTotalBoltsForTable(state.currentTableType);
  const totalRemaining = totalBolts - totalCompleted;
  const totalPercent = totalBolts > 0 ? (totalCompleted / totalBolts) * 100 : 0;

  document.getElementById('progress-completed').textContent = totalCompleted;
  document.getElementById('progress-remaining').textContent = totalRemaining;
  document.getElementById('progress-total').textContent = totalBolts;
  document.getElementById('progress-fill').style.width = `${totalPercent}%`;

  if (isDone) {
    document.getElementById('spec-position').textContent = `Wrench size ${state.currentWrenchSize} Complete`;
    document.getElementById('spec-size').textContent = 'N/A';
    document.getElementById('spec-target').textContent = 'N/A';
    document.getElementById('spec-tolerance').textContent = 'N/A';
    document.getElementById('spec-min').textContent = 'N/A';
    document.getElementById('spec-max').textContent = 'N/A';
    
    measuredInput.value = '';
    measuredInput.disabled = true;
    document.getElementById('btn-submit-result').disabled = true;
    document.getElementById('btn-next-bolt').disabled = true;
    
    const badge = document.getElementById('result-badge');
    badge.textContent = 'SIZE COMPLETED';
    badge.className = 'result-badge pass';
    return;
  }

  // Load current active bolt specs
  const bolt = state.boltsList[state.currentBoltIndex];

  document.getElementById('spec-position').textContent = bolt.BoltPosition;
  document.getElementById('spec-size').textContent = bolt.BoltSize;
  document.getElementById('spec-target').textContent = `${bolt.TargetTorque} Nm`;
  document.getElementById('spec-tolerance').textContent = `Range-based`;
  document.getElementById('spec-min').textContent = `${bolt.MinTorque.toFixed(1)} Nm`;
  document.getElementById('spec-max').textContent = `${bolt.MaxTorque.toFixed(1)} Nm`;
  
  measuredInput.disabled = false;
  measuredInput.value = '';
  measuredInput.focus();
  
  const badge = document.getElementById('result-badge');
  badge.textContent = 'WAITING';
  badge.className = 'result-badge';
  
  document.getElementById('btn-submit-result').disabled = true;
  document.getElementById('btn-next-bolt').disabled = false;
}

// Torque evaluation logic
function evaluateTorque() {
  const measuredInput = document.getElementById('measured-torque');
  const valText = measuredInput.value.trim();
  const badge = document.getElementById('result-badge');
  const submitBtn = document.getElementById('btn-submit-result');

  if (valText === '') {
    badge.textContent = 'WAITING';
    badge.className = 'result-badge';
    submitBtn.disabled = true;
    return;
  }

  const measured = parseFloat(valText);
  if (isNaN(measured)) {
    badge.textContent = 'INVALID';
    badge.className = 'result-badge fail';
    submitBtn.disabled = true;
    return;
  }

  const bolt = state.boltsList[state.currentBoltIndex];
  const pass = measured >= bolt.MinTorque && measured <= bolt.MaxTorque;

  if (pass) {
    badge.textContent = 'PASS';
    badge.className = 'result-badge pass';
  } else {
    badge.textContent = 'FAIL';
    badge.className = 'result-badge fail';
  }
  
  submitBtn.disabled = false;
}

async function handleSubmitResult() {
  const measuredInput = document.getElementById('measured-torque');
  const measured = parseFloat(measuredInput.value);
  if (isNaN(measured)) return;

  const bolt = state.boltsList[state.currentBoltIndex];
  const isPass = measured >= bolt.MinTorque && measured <= bolt.MaxTorque;
  
  const table = state.tables.find(t => t.TableID === state.currentTableId);

  const record = {
    Timestamp: Date.now(),
    Inspector: state.currentInspector,
    ProjectID: state.currentProjectId,
    StationID: state.currentStationId,
    TableID: state.currentTableId,
    TableNumber: table ? table.TableNumber : '',
    WrenchSize: state.currentWrenchSize,
    BoltPosition: bolt.BoltPosition,
    BoltSize: bolt.BoltSize,
    TargetTorque: bolt.TargetTorque,
    MeasuredTorque: measured,
    Result: isPass ? 'PASS' : 'FAIL',
    Synced: false
  };

  try {
    await saveInspectionRecord(record);
    
    if (navigator.vibrate) navigator.vibrate(50);
    state.tableRecords.push(record);
    
    await loadRecentRecords();
    
    state.currentBoltIndex++;
    renderInspectionInterface();
    
  } catch (err) {
    console.error('Error saving record:', err);
    alert('Failed to save record to IndexedDB');
  }
}

async function loadRecentRecords() {
  const records = await getRecentRecords(10);
  const recordsList = document.getElementById('recent-records-list');
  
  if (records.length === 0) {
    recordsList.innerHTML = '<div class="no-records">No recent records found</div>';
    return;
  }

  recordsList.innerHTML = '';
  records.forEach(rec => {
    const item = document.createElement('div');
    item.className = 'record-item';
    
    const timeStr = new Date(rec.Timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const dateStr = new Date(rec.Timestamp).toLocaleDateString([], { month: 'short', day: 'numeric' });
    
    item.innerHTML = `
      <div class="record-left">
        <div class="record-title">${rec.TableNumber} - ${rec.BoltPosition}</div>
        <div class="record-subtitle">${dateStr} ${timeStr} | Project: ${rec.ProjectID} | ${rec.Inspector}</div>
      </div>
      <div class="record-right">
        <div class="record-val">${rec.MeasuredTorque} Nm</div>
        <div class="record-tag ${rec.Result.toLowerCase()}">${rec.Result}</div>
      </div>
    `;
    recordsList.appendChild(item);
  });
}

// -------------------------------------------------------------
// 4. BLE SMART TORQUE INTEGRATION & HARDWARE SIMULATORS
// -------------------------------------------------------------

// Web Audio API confirmation synth chime (double chime beep)
function playConfirmationSound() {
  try {
    // Standardize across browsers
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const audioCtx = new AudioCtx();
    
    const playTone = (freq, startTime, duration) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, startTime);
      
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(0.15, startTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration - 0.02);
      
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      
      osc.start(startTime);
      osc.stop(startTime + duration);
    };

    // Synthesize double beep sound (880Hz then 1320Hz)
    playTone(880, audioCtx.currentTime, 0.18);
    playTone(1320, audioCtx.currentTime + 0.08, 0.22);
  } catch (e) {
    console.warn('Web Audio Playback failed:', e);
  }
}

// Flash highlight animation triggers
function highlightTorqueInput() {
  const input = document.getElementById('measured-torque');
  if (input) {
    input.classList.remove('highlight-flash');
    void input.offsetWidth; // trigger layout reflow to restart animation
    input.classList.add('highlight-flash');
  }
}

// Move focus to Submit & Save button
function focusSubmitButton() {
  const submitBtn = document.getElementById('btn-submit-result');
  if (submitBtn && !submitBtn.disabled) {
    submitBtn.focus();
  }
}

// Web Bluetooth BLE connection triggers
async function connectBLEDevice() {
  if (!navigator.bluetooth) {
    alert('Web Bluetooth API is not supported in this browser. On iPhones (iOS), please use "Bluefy" or "WebBLE" browser to connect BLE hardware.');
    return;
  }
  
  updateBLEStatus('connecting');
  
  try {
    console.log('Requesting BLE Wrench device...');
    state.bleDevice = await navigator.bluetooth.requestDevice({
      filters: [
        { namePrefix: BLE_DEVICE_NAME_PREFIX },
        { services: [BLE_SERVICE_UUID] }
      ],
      optionalServices: [BLE_SERVICE_UUID]
    });
    
    state.bleDeviceName = state.bleDevice.name || 'Smart Torque Wrench';
    console.log(`Device selected: ${state.bleDeviceName}. Connecting GATT server...`);
    
    state.bleDevice.addEventListener('gattserverdisconnected', onBLEDisconnected);
    
    const server = await state.bleDevice.gatt.connect();
    
    console.log('GATT server connected. Getting service...');
    const service = await server.getPrimaryService(BLE_SERVICE_UUID);
    
    console.log('Service obtained. Getting characteristic...');
    state.bleCharacteristic = await service.getCharacteristic(BLE_CHARACTERISTIC_UUID);
    
    console.log('Characteristic obtained. Starting notifications...');
    await state.bleCharacteristic.startNotifications();
    state.bleCharacteristic.addEventListener('characteristicvaluechanged', onBLECharacteristicChanged);
    
    console.log('Notifications subscribed. BLE Wrench active!');
    updateBLEStatus('connected');
    
  } catch (err) {
    console.error('BLE connection failed:', err);
    updateBLEStatus('disconnected', err.message || 'Connection failed.');
  }
}

function disconnectBLEDevice() {
  console.log('Disconnecting BLE wrench...');
  if (state.bleCharacteristic) {
    try {
      state.bleCharacteristic.removeEventListener('characteristicvaluechanged', onBLECharacteristicChanged);
    } catch (e) {}
    state.bleCharacteristic = null;
  }
  
  if (state.bleDevice) {
    state.bleDevice.removeEventListener('gattserverdisconnected', onBLEDisconnected);
    if (state.bleDevice.gatt && state.bleDevice.gatt.connected) {
      state.bleDevice.gatt.disconnect();
    }
    state.bleDevice = null;
  }
  
  updateBLEStatus('disconnected');
}

function onBLEDisconnected() {
  console.warn('BLE device disconnected unexpectedly.');
  
  // Show warning reconnection banner on Inspect Section
  document.getElementById('ble-warning-banner').style.display = 'flex';
  
  // Vibrate warning pattern
  if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
  
  disconnectBLEDevice();
}

function onBLECharacteristicChanged(event) {
  const value = event.target.value;
  try {
    const decoder = new TextDecoder('utf-8');
    const rawString = decoder.decode(value);
    handleIncomingBLEData(rawString);
  } catch (err) {
    console.error('Failed to decode characteristic buffer value:', err);
  }
}

// Parses BLE notification payloads and updates app values
function handleIncomingBLEData(rawString) {
  console.log('Raw BLE Data arrived:', rawString);
  
  const timestamp = new Date();
  const dateStr = timestamp.toISOString().split('T')[0];
  const timeStr = timestamp.toTimeString().split(' ')[0];
  state.lastBleRaw = rawString;
  state.lastBleTimestamp = `${dateStr} ${timeStr}`;
  
  // Parse torque float from payload, e.g. "Torque: 6.5 Nm"
  const match = rawString.match(/Torque:\s*([0-9.]+)\s*Nm/i) || rawString.match(/([0-9.]+)/);
  let parsedTorque = null;
  
  if (match) {
    const val = parseFloat(match[1]);
    if (!isNaN(val)) {
      parsedTorque = val;
    }
  }

  // Update UI Status Logs
  document.getElementById('ble-last-raw-msg').textContent = rawString;
  document.getElementById('ble-last-timestamp').textContent = state.lastBleTimestamp;
  
  // Update collapsible debug fields
  document.getElementById('debug-raw-msg').textContent = rawString;
  document.getElementById('debug-parsed-torque').textContent = parsedTorque !== null ? `${parsedTorque} Nm` : 'N/A';

  if (parsedTorque !== null) {
    const input = document.getElementById('measured-torque');
    // Fill in only if inspection is active (table selected and not completed)
    if (input && !input.disabled) {
      input.value = parsedTorque;
      evaluateTorque();
      
      // Post BLE actions
      highlightTorqueInput();
      playConfirmationSound();
      
      // Auto-focus submit button
      setTimeout(focusSubmitButton, 100);
    }
  }
}

// Updates Bluetooth connection panel elements based on state change
function updateBLEStatus(status, errorMsg = '') {
  state.bleStatus = status;
  
  const label = document.getElementById('ble-panel-status-label');
  const div = document.getElementById('ble-panel-status-div');
  const connBtn = document.getElementById('btn-connect-ble');
  const disconnBtn = document.getElementById('btn-disconnect-ble');
  const nameRow = document.getElementById('ble-device-name-row');
  const connectedName = document.getElementById('ble-connected-device-name');
  
  // Update Inspect tab small indicators
  const inspectLabel = document.getElementById('bt-status-label');
  const inspectDiv = document.getElementById('bt-status-div');

  // Update debug stats
  document.getElementById('debug-gatt-state').textContent = status;
  document.getElementById('debug-device-name').textContent = status === 'connected' ? state.bleDeviceName : 'None';

  if (status === 'connected') {
    document.getElementById('ble-warning-banner').style.display = 'none';
    
    div.className = 'bt-status connected';
    label.textContent = 'Connected';
    inspectDiv.className = 'bt-status connected';
    inspectLabel.textContent = 'Connected';
    
    connBtn.style.display = 'none';
    disconnBtn.style.display = 'block';
    
    nameRow.style.display = 'block';
    connectedName.textContent = state.bleDeviceName;
  } else if (status === 'connecting') {
    div.className = 'bt-status connecting';
    label.textContent = 'Connecting...';
    inspectDiv.className = 'bt-status connecting';
    inspectLabel.textContent = 'Connecting...';
    
    connBtn.disabled = true;
    connBtn.textContent = 'Connecting...';
    disconnBtn.style.display = 'none';
    nameRow.style.display = 'none';
  } else {
    // disconnected
    div.className = 'bt-status disconnected';
    label.textContent = 'Disconnected';
    inspectDiv.className = 'bt-status disconnected';
    inspectLabel.textContent = 'Disconnected';
    
    connBtn.disabled = false;
    connBtn.style.display = 'block';
    connBtn.textContent = 'Connect Smart Torque';
    
    disconnBtn.style.display = 'none';
    nameRow.style.display = 'none';
    
    if (errorMsg && errorMsg !== 'User cancelled the requestDevice() chooser.') {
      alert(`BLE Error: ${errorMsg}`);
    }
  }
}

// Check if Web Bluetooth API is supported on startup
function checkBLESupport() {
  const connBtn = document.getElementById('btn-connect-ble');
  if (!navigator.bluetooth) {
    if (connBtn) {
      connBtn.disabled = true;
      connBtn.textContent = '🚫 BLE Not Supported';
      connBtn.title = 'Web Bluetooth API is not supported in this browser.';
    }
    document.getElementById('ble-panel-status-label').textContent = 'API Not Supported';
    document.getElementById('ble-panel-status-div').className = 'bt-status disconnected';
  }
}

// Legacy Simulated Wrench (Bluetooth Wrench Simulator button logic)
function toggleBluetoothWrench() {
  if (state.bluetoothConnected) {
    state.bluetoothConnected = false;
    document.getElementById('bt-status-label').textContent = 'Disconnected';
    document.getElementById('bt-status-div').className = 'bt-status';
    document.getElementById('bt-wrench-toggle').textContent = 'Connect Simulator Wrench';
    document.getElementById('bt-wrench-toggle').className = 'btn btn-secondary';
    document.getElementById('btn-read-torque').title = 'Bluetooth offline';
  } else {
    state.bluetoothConnected = true;
    document.getElementById('bt-status-label').textContent = 'Connected (Mock)';
    document.getElementById('bt-status-div').className = 'bt-status connected';
    document.getElementById('bt-wrench-toggle').textContent = 'Disconnect Simulator Wrench';
    document.getElementById('bt-wrench-toggle').className = 'btn btn-success';
    document.getElementById('btn-read-torque').title = 'Click to pull wrench value';
  }
}

function handleReadTorque() {
  // Pull from simulated wrench modal if connected, else redirect to BLE Connect instructions
  if (state.bluetoothConnected) {
    openSimulatorModal();
  } else if (state.bleStatus === 'connected') {
    alert('Web app is connected to the real BLE Smart Torque device. Please torque a bolt, values will sync automatically!');
  } else {
    alert('Please connect either the real BLE device or the mock simulator wrench in Settings!');
    switchTab('settings');
  }
}

function openSimulatorModal() {
  const modal = document.getElementById('wrench-simulator-modal');
  const bolt = state.boltsList[state.currentBoltIndex];
  const target = bolt.TargetTorque;
  
  const slider = document.getElementById('sim-torque-range');
  const valueDisplay = document.getElementById('sim-torque-value');
  
  slider.min = Math.floor(target * 0.6);
  slider.max = Math.ceil(target * 1.4);
  slider.value = target;
  valueDisplay.textContent = `${target} Nm`;
  
  modal.classList.add('show');
}

function closeSimulatorModal() {
  document.getElementById('wrench-simulator-modal').classList.remove('show');
}

function updateSimulatorValue(val) {
  document.getElementById('sim-torque-value').textContent = `${val} Nm`;
}

function sendSimulatedTorque() {
  const val = parseFloat(document.getElementById('sim-torque-range').value);
  const measuredInput = document.getElementById('measured-torque');
  measuredInput.value = val.toFixed(1);
  closeSimulatorModal();
  evaluateTorque();
}

// QR Scanner Simulator Modal
function openQRScanner() {
  if (!state.currentStationId) {
    alert('Please select a Transformer Station first!');
    return;
  }

  const modal = document.getElementById('qr-scanner-modal');
  modal.classList.add('show');

  const viewport = document.getElementById('scanner-viewport');
  viewport.innerHTML = `
    <div class="scanner-laser"></div>
    <div class="scanner-overlay-box"></div>
    <video id="scanner-video" class="scanner-video-feed" autoplay playsinline></video>
  `;

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(stream => {
        const video = document.getElementById('scanner-video');
        if (video) {
          video.srcObject = stream;
          state.cameraStream = stream;
        }
      })
      .catch(err => {
        console.warn('Webcam permission denied, loading simulated overlay:', err);
        viewport.innerHTML = `
          <div class="scanner-laser"></div>
          <div class="scanner-overlay-box"></div>
          <div style="position:absolute; top:40%; left:10px; right:10px; text-align:center; color:#FF7A00; font-size:0.8rem; font-weight:600;">
            [CAMERA SIMULATION ON]
          </div>
        `;
      });
  }
  
  const qrSelect = document.getElementById('qr-simulated-scan-select');
  qrSelect.innerHTML = '<option value="">-- Choose Mock QR Code to Scan --</option>';
  
  state.tables.forEach(tbl => {
    const opt = document.createElement('option');
    opt.value = tbl.TableID;
    opt.textContent = `QR Code: ${tbl.TableNumber} (${tbl.TableType === 'Full' ? 'Full' : 'Half'})`;
    qrSelect.appendChild(opt);
  });
}

function closeQRScanner() {
  document.getElementById('qr-scanner-modal').classList.remove('show');
  
  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach(track => track.stop());
    state.cameraStream = null;
  }
}

function handleQRScanResult(tableId) {
  if (!tableId) return;
  
  const table = state.tables.find(t => t.TableID === tableId);
  if (table) {
    searchInput.value = table.TableNumber;
    closeQRScanner();
    handleTableSelection(tableId);
  }
}

// -------------------------------------------------------------
// 5. EXPORT LOGIC (CSV and Excel formats with WKWebView/Mobile support)
// -------------------------------------------------------------
let pendingExportData = {
  content: '',
  tsvContent: '',
  fileName: '',
  contentType: '',
  recordsCount: 0,
  format: ''
};

async function exportToCSV() {
  const records = await getAllFromStore('records');
  if (records.length === 0) {
    alert('No records available to export');
    return;
  }

  let csvContent = 'RecordID,Timestamp,Date,Time,Inspector,ProjectID,StationID,TableID,TableNumber,WrenchSize,BoltPosition,BoltSize,TargetTorque(Nm),MeasuredTorque(Nm),Result\n';
  
  records.forEach(r => {
    const date = new Date(r.Timestamp);
    const dateStr = date.toISOString().split('T')[0];
    const timeStr = date.toTimeString().split(' ')[0];
    
    const inspector = `"${r.Inspector.replace(/"/g, '""')}"`;
    const position = `"${r.BoltPosition.replace(/"/g, '""')}"`;
    
    csvContent += `${r.RecordID},${r.Timestamp},${dateStr},${timeStr},${inspector},${r.ProjectID},${r.StationID},${r.TableID},${r.TableNumber},${r.WrenchSize},${position},${r.BoltSize},${r.TargetTorque},${r.MeasuredTorque},${r.Result}\n`;
  });

  pendingExportData = {
    content: csvContent,
    tsvContent: csvContent,
    fileName: 'torque_inspection_records.csv',
    contentType: 'text/csv;charset=utf-8;',
    recordsCount: records.length,
    format: 'CSV'
  };

  showExportModal();
}

async function exportToExcel() {
  const records = await getAllFromStore('records');
  if (records.length === 0) {
    alert('No records available to export');
    return;
  }

  let excelHTML = `
    <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
    <head>
      <meta http-equiv="content-type" content="application/vnd.ms-excel; charset=UTF-8">
      <style>
        table { border-collapse: collapse; }
        th { background-color: #FF7A00; color: #121212; font-weight: bold; border: 1px solid #ddd; padding: 6px; }
        td { border: 1px solid #ddd; padding: 6px; }
        .pass { background-color: #C8E6C9; color: #256029; font-weight: bold; }
        .fail { background-color: #FFCDD2; color: #C63737; font-weight: bold; }
      </style>
    </head>
    <body>
      <h2>Torque Inspection System Report</h2>
      <p>Export Date: ${new Date().toLocaleString()}</p>
      <table>
        <thead>
          <tr>
            <th>ID</th>
            <th>Date</th>
            <th>Time</th>
            <th>Inspector</th>
            <th>Project ID</th>
            <th>Station ID</th>
            <th>Table Number</th>
            <th>Wrench Size</th>
            <th>Bolt Position</th>
            <th>Bolt Size</th>
            <th>Target Torque (Nm)</th>
            <th>Measured Torque (Nm)</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
  `;

  records.forEach(r => {
    const d = new Date(r.Timestamp);
    const dateStr = d.toLocaleDateString();
    const timeStr = d.toLocaleTimeString();
    
    excelHTML += `
      <tr>
        <td>${r.RecordID}</td>
        <td>${dateStr}</td>
        <td>${timeStr}</td>
        <td>${r.Inspector}</td>
        <td>${r.ProjectID}</td>
        <td>${r.StationID}</td>
        <td>${r.TableNumber}</td>
        <td>${r.WrenchSize}</td>
        <td>${r.BoltPosition}</td>
        <td>${r.BoltSize}</td>
        <td>${r.TargetTorque}</td>
        <td>${r.MeasuredTorque}</td>
        <td class="${r.Result.toLowerCase()}">${r.Result}</td>
      </tr>
    `;
  });

  excelHTML += `
        </tbody>
      </table>
    </body>
    </html>
  `;

  // Generate clean tab-separated values for Excel clipboard paste
  let tsvContent = 'ID\tDate\tTime\tInspector\tProject ID\tStation ID\tTable Number\tWrench Size\tBolt Position\tBolt Size\tTarget Torque (Nm)\tMeasured Torque (Nm)\tResult\n';
  records.forEach(r => {
    const d = new Date(r.Timestamp);
    const dateStr = d.toLocaleDateString();
    const timeStr = d.toLocaleTimeString();
    const clean = (val) => String(val).replace(/\t/g, ' ').replace(/\n/g, ' ');
    tsvContent += `${r.RecordID}\t${dateStr}\t${timeStr}\t${clean(r.Inspector)}\t${r.ProjectID}\t${r.StationID}\t${r.TableNumber}\t${r.WrenchSize}\t${clean(r.BoltPosition)}\t${r.BoltSize}\t${r.TargetTorque}\t${r.MeasuredTorque}\t${r.Result}\n`;
  });

  pendingExportData = {
    content: excelHTML,
    tsvContent: tsvContent,
    fileName: 'torque_inspection_report.xls',
    contentType: 'application/vnd.ms-excel',
    recordsCount: records.length,
    format: 'Excel'
  };

  showExportModal();
}

function showExportModal() {
  const modal = document.getElementById('export-options-modal');
  if (!modal) return;
  
  // Set format badge
  const badge = document.getElementById('export-format-badge');
  if (badge) {
    badge.textContent = `${pendingExportData.format} FORMAT`;
    if (pendingExportData.format === 'Excel') {
      badge.style.backgroundColor = 'rgba(0, 230, 118, 0.15)';
      badge.style.color = '#00E676';
    } else {
      badge.style.backgroundColor = 'var(--orange-light)';
      badge.style.color = 'var(--orange)';
    }
  }
  
  // Set records count
  const countText = document.getElementById('export-records-count');
  if (countText) {
    countText.textContent = `Total: ${pendingExportData.recordsCount} records found`;
  }
  
  // Toggle share button based on support
  const shareBtn = document.getElementById('btn-export-share');
  if (shareBtn) {
    if (!navigator.share) {
      shareBtn.style.display = 'none';
    } else {
      shareBtn.style.display = 'flex';
    }
  }

  modal.classList.add('show');
}

function closeExportModal() {
  const modal = document.getElementById('export-options-modal');
  if (modal) modal.classList.remove('show');
}

// Click handlers for the export modal actions (run completely synchronously to keep user gesture)
function handleModalShare() {
  const content = pendingExportData.content;
  const fileName = pendingExportData.fileName;
  const contentType = pendingExportData.contentType;
  const blob = new Blob([content], { type: contentType });

  if (navigator.share) {
    try {
      const file = new File([blob], fileName, { type: contentType });
      navigator.share({
        files: [file],
        title: fileName,
        text: 'Deep Torque Inspection Report'
      }).then(() => {
        console.log('Shared successfully');
      }).catch(err => {
        console.warn('Share rejected or failed:', err);
        if (err.name !== 'AbortError') {
          alert('Sharing failed. Please try "Download" or "Copy to Clipboard".');
        }
      });
    } catch (err) {
      console.error('Failed to create file or share:', err);
      alert('Sharing is not fully supported in this browser. Please try "Copy to Clipboard".');
    }
  } else {
    alert('Web Share is not supported in this browser.');
  }
}

function handleModalDownload() {
  const content = pendingExportData.content;
  const fileName = pendingExportData.fileName;
  const contentType = pendingExportData.contentType;
  const blob = new Blob([content], { type: contentType });

  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    console.log('Download triggered successfully');
  } catch (err) {
    console.error('Download failed:', err);
    alert('Direct downloads are blocked in this WebView. Please try "Share File" or "Copy to Clipboard".');
  }
}

function handleModalCopy() {
  const textToCopy = pendingExportData.tsvContent || pendingExportData.content;

  const doExecCopy = () => {
    const textarea = document.createElement('textarea');
    textarea.value = textToCopy;
    textarea.style.position = 'fixed'; // prevent scrolling
    document.body.appendChild(textarea);
    textarea.select();
    try {
      document.execCommand('copy');
      alert('Report data copied to clipboard! You can paste it directly into Excel.');
    } catch (err) {
      console.error('execCommand copy failed:', err);
      alert('Failed to copy. Please manually select and copy.');
    } finally {
      document.body.removeChild(textarea);
      closeExportModal();
    }
  };

  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(textToCopy).then(() => {
        alert('Report data copied to clipboard! You can paste it directly into Excel.');
        closeExportModal();
      }).catch(err => {
        console.warn('navigator.clipboard failed, using fallback:', err);
        doExecCopy();
      });
    } else {
      doExecCopy();
    }
  } catch (err) {
    doExecCopy();
  }
}


// -------------------------------------------------------------
// 6. INITIALIZATION & TAB ROUTING
// -------------------------------------------------------------
function switchTab(tabId) {
  state.activeTab = tabId;
  
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  
  document.getElementById('inspect-section').style.display = tabId === 'inspect' ? 'flex' : 'none';
  document.getElementById('records-section').style.display = tabId === 'records' ? 'block' : 'none';
  document.getElementById('settings-section').style.display = tabId === 'settings' ? 'flex' : 'none';

  if (tabId === 'records') {
    loadRecentRecords();
  }
}

function updateOnlineStatus() {
  const statusDot = document.getElementById('connection-status-dot');
  const statusLabel = document.getElementById('connection-status-label');
  
  if (navigator.onLine) {
    statusDot.className = 'status-dot';
    statusLabel.textContent = 'Online';
  } else {
    statusDot.className = 'status-dot offline';
    statusLabel.textContent = 'Offline';
  }
}

// Setup Event Listeners
function setupEventListeners() {
  // Project selector change event
  document.getElementById('project-select').addEventListener('change', (e) => {
    handleProjectSelection(e.target.value);
  });

  // Station selector change event
  document.getElementById('station-select').addEventListener('change', (e) => {
    handleStationSelection(e.target.value);
  });

  // Wrench size selector button clicks
  document.querySelectorAll('.wrench-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      handleWrenchSizeChange(btn.dataset.size);
    });
  });
  
  // Tab Routing
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Manual Torque input evaluation
  document.getElementById('measured-torque').addEventListener('input', evaluateTorque);

  // Submit Result Action
  document.getElementById('btn-submit-result').addEventListener('click', handleSubmitResult);

  // Save/Next Bolt Actions (allows skipping)
  document.getElementById('btn-next-bolt').addEventListener('click', () => {
    if (state.currentBoltIndex < state.boltsList.length) {
      state.currentBoltIndex++;
      renderInspectionInterface();
    }
  });

  // BLE Panel button connections
  document.getElementById('btn-connect-ble').addEventListener('click', connectBLEDevice);
  document.getElementById('btn-disconnect-ble').addEventListener('click', () => disconnectBLEDevice());
  document.getElementById('btn-reconnect-ble-banner').addEventListener('click', (e) => {
    e.stopPropagation();
    connectBLEDevice();
  });

  // Collapsible Debug panel Toggle
  const debugToggle = document.getElementById('ble-debug-toggle');
  const debugContent = document.getElementById('ble-debug-content');
  const debugArrow = document.getElementById('ble-debug-arrow');
  if (debugToggle && debugContent) {
    debugToggle.addEventListener('click', () => {
      const isShow = debugContent.classList.toggle('show');
      debugArrow.textContent = isShow ? '▲' : '▼';
    });
  }

  // Simulated BLE Notification trigger (Manual Testing)
  const simulateBtn = document.getElementById('btn-simulate-ble-notify');
  if (simulateBtn) {
    simulateBtn.addEventListener('click', () => {
      let fakeRaw = '';
      if (state.boltsList && state.boltsList[state.currentBoltIndex]) {
        const target = state.boltsList[state.currentBoltIndex].TargetTorque;
        // Generate random simulated torque ±15% around target
        const offset = (Math.random() - 0.4) * 0.3 * target;
        const fakeTorque = (target + offset).toFixed(1);
        fakeRaw = `Torque: ${fakeTorque} Nm`;
      } else {
        fakeRaw = `Torque: ${(20 + Math.random() * 60).toFixed(1)} Nm`;
      }
      handleIncomingBLEData(fakeRaw);
    });
  }

  // Legacy Simulator Triggers
  document.getElementById('btn-read-torque').addEventListener('click', handleReadTorque);
  document.getElementById('bt-wrench-toggle').addEventListener('click', toggleBluetoothWrench);
  document.getElementById('sim-submit-torque').addEventListener('click', sendSimulatedTorque);
  document.getElementById('sim-cancel-torque').addEventListener('click', closeSimulatorModal);
  document.getElementById('sim-torque-range').addEventListener('input', (e) => {
    updateSimulatorValue(e.target.value);
  });

  // QR Actions
  document.getElementById('btn-qr-scan').addEventListener('click', openQRScanner);
  document.getElementById('qr-scanner-close').addEventListener('click', closeQRScanner);
  document.getElementById('qr-simulated-scan-select').addEventListener('change', (e) => {
    handleQRScanResult(e.target.value);
  });

  // Settings Inspector Setup
  const inspectorInput = document.getElementById('inspector-name-input');
  inspectorInput.value = state.currentInspector;
  inspectorInput.addEventListener('change', (e) => {
    const name = e.target.value.trim() || 'Inspector';
    state.currentInspector = name;
    localStorage.setItem('inspectorName', name);
  });

  // Clear Database button
  document.getElementById('btn-clear-db').addEventListener('click', async () => {
    const confirmClear = confirm('Are you sure you want to delete all recorded inspections? This action is irreversible.');
    if (confirmClear) {
      await clearAllRecords();
      alert('Local inspection records cleared.');
      if (state.currentTableId) {
        handleTableSelection(state.currentTableId);
      } else {
        resetInspectionSection();
      }
      loadRecentRecords();
    }
  });

  // Export Buttons
  document.getElementById('btn-export-csv').addEventListener('click', exportToCSV);
  document.getElementById('btn-export-excel').addEventListener('click', exportToExcel);

  // Export Modal Triggers
  document.getElementById('export-modal-close').addEventListener('click', closeExportModal);
  document.getElementById('btn-export-share').addEventListener('click', handleModalShare);
  document.getElementById('btn-export-download').addEventListener('click', handleModalDownload);
  document.getElementById('btn-export-copy').addEventListener('click', handleModalCopy);

  // Network Monitoring
  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
}

// Main Launch Sequence
window.addEventListener('DOMContentLoaded', async () => {
  try {
    // 1. Initialize IndexedDB
    await initDatabase();
    
    // 2. Load Seed Data
    await seedDatabaseIfEmpty();
    
    // 3. Load Project list
    await loadProjectsDropdown();
    
    // 4. Setup Custom Search Menu
    setupSearchableDropdown();
    
    // 5. Connect UI Triggers
    setupEventListeners();
    
    // 6. Online Status Check
    updateOnlineStatus();
    
    // 7. Initial records loading
    await loadRecentRecords();
    
    // 8. Check startup BLE Support
    checkBLESupport();
    
    // 9. Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('./sw.js')
        .then(reg => console.log('Service Worker registered. Scope:', reg.scope))
        .catch(err => console.error('Service Worker registration failed:', err));
    }
    
    console.log('Torque Inspection System initialized successfully');
  } catch (error) {
    console.error('Initialization failed:', error);
  }
});
