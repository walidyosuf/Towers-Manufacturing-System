// renderer.js - Tower Manufacturing Management System v2.4.1
// ============================================================================
// ✅ v2.4.1: زر «Add Daily Production» في قسم الإنتاج اليدوي — لوحة الإدخال
//           اليدوي مخفية افتراضياً وتُفتح بالزر (بنفس نمط Models/WO/Downtime/NCR)
//           مع تكامل مع لوحة Excel: فتح إحداهما يُغلق الأخرى.
// ✅ v2.4.0: Daily Production Import from Excel — طريقة إضافية لإدخال الإنتاج
//           اليومي عبر ملف Excel مع أعمدة Machine / Shift / Operator تُملأ
//           تلقائياً بناءً على نوع العملية التشغيلية (getMachineForOperation).
// ✅ v2.3.1: لوحات الإدخال مخفية افتراضياً
// ✅ v2.3.0: Sales Order Family Tree
// ✅ v2.2.14: Chart View لـ Sales Order Family Tree
// ✅ v2.2.13: Sales Order Family Tree (Table + Cards View)
// ✅ v2.2.12: سبب NCR + اسم العامل + نوع العطل في Downtime
// ✅ v2.2.11: بحث NCR
// ✅ v2.2.10: إلغاء Galvanizing + Finish آخر عملية
// ✅ v2.2.9:  completedQuantity = الحد الأدنى بين العمليات (bottleneck)
// ============================================================================

// ============= GLOBAL VARIABLES =============
const SERVER_URL = 'http://192.168.0.17:3000';
let db = [];
let workOrdersDB = [];
let productionDB = [];
let machineOperatorsDB = {};
let downtimeDB = [];
let machineIdealRates = {};
let ncrDB = [];
let employeesDB = [];
let usersDB = [];
let balanceMode = false;
let syncedRecordIds = new Set();
let dataReady = false;
let pendingSaves = 0;
const lastSavePayload = {};
const unconfirmedTypes = new Set();

let allWorkOrderOptions = {};

function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const STATUS = {
    PENDING: 'Pending',
    IN_PROGRESS: 'In Progress',
    COMPLETED: 'Completed',
    BLOCKED: 'Blocked'
};

let appConfig = {
    version: '2.4.1',
    settings: {},
    lastBackup: null,
    backupSchedule: 'none'
};

let currentWorkOrderFilter = 'inprogress';
let currentAvailableItems = [];
let productionPreferences = {};
let currentWorkOrder = null;
let currentProduction = null;
let currentExcelData = null;
let currentWorkOrderData = null;
let currentProductionExcelData = null;   // ✅ v2.4.0 — Excel rows buffer for production import
let pendingDeleteAction = null;
let pendingDeleteData = null;
let allItemsForReport = [];
let allItemsForReportFiltered = [];

function getMachinesByPhase(phase) {
    const allMachines = ['206', '20.20', '10.10', 'Cropping', 'Manual Plasma', 'Press', 'Drill', 'Chamfering', 'Shear', '83P', 'CNC Bending', 'Finishing'];
    if (!phase) return allMachines;
    const phaseMap = {
        'minimum': ['206', '20.20', '10.10', '83P'],
        'crop': ['Cropping', 'Manual Plasma'],
        'shear': ['Shear'],
        'bend': ['Press', 'CNC Bending'],
        'drill': ['Drill'],
        'chamfer': ['Chamfering'],
        'finish': ['Finishing']
    };
    return phaseMap[phase] || allMachines;
}

function yieldToUI() {
    return new Promise(resolve => {
        requestAnimationFrame(() => setTimeout(resolve, 0));
    });
}

// ============================================================================
// ✅ HELPERS: تصنيف واستكمال العمليات
// ============================================================================
function isGalvanizingOperation(op) {
    const name = (op && op.name ? op.name : (typeof op === 'string' ? op : '')).toString().toLowerCase();
    return name.includes('galv');
}

function isFinishOperation(op) {
    const name = (op && op.name ? op.name : (typeof op === 'string' ? op : '')).toString().toLowerCase();
    return name.includes('finish');
}

function normalizeItemOperations(ops) {
    if (!ops || !Array.isArray(ops)) return ops;
    const filtered = ops.filter(op => !isGalvanizingOperation(op));
    const others = filtered.filter(op => !isFinishOperation(op));
    const finishOps = filtered.filter(op => isFinishOperation(op));
    return [...others, ...finishOps];
}

function recalcItemCompletedQuantity(item) {
    if (!item || !item.operations || item.operations.length === 0) return 0;
    let minCompleted = Infinity;
    item.operations.forEach(op => {
        const comp = item.completedOperations ? item.completedOperations[op.name] : null;
        const qty = comp ? (parseInt(comp.completedQuantity) || 0) : 0;
        if (qty < minCompleted) minCompleted = qty;
    });
    if (minCompleted === Infinity) minCompleted = 0;
    return Math.min(minCompleted, item.quantity || 0);
}

function recalcItemStatus(item) {
    if (!item) return;
    item.completedQuantity = recalcItemCompletedQuantity(item);
    let allComplete = true;
    let anyCompleted = false;
    item.operations.forEach(op => {
        const comp = item.completedOperations ? item.completedOperations[op.name] : null;
        const qty = comp ? (parseInt(comp.completedQuantity) || 0) : 0;
        if (qty < item.quantity) allComplete = false;
        if (qty > 0) anyCompleted = true;
    });
    if (item.status === 'Blocked') return;
    if (allComplete && item.completedQuantity >= item.quantity) {
        item.status = STATUS.COMPLETED;
    } else if (anyCompleted) {
        item.status = STATUS.IN_PROGRESS;
    } else {
        item.status = STATUS.PENDING;
    }
}

// ============= AUTH & PERMISSIONS =============
const ROLES = {
    PLANNING: 'planning',
    PRODUCTION: 'production',
    QC: 'qc',
    PROJECTS: 'projects',
    TOP_MANAGEMENT: 'top_management',
    ADMINISTRATOR: 'administrator'
};

const PERMISSIONS = {
    [ROLES.ADMINISTRATOR]: {
        canViewDashboard: true, canViewReports: true, canViewWorkOrders: true, canViewProduction: true,
        canViewDowntime: true, canViewNCR: true, canViewHR: true, canViewModels: true, canViewSettings: true,
        canManageUsers: true, canCreateWorkOrder: true, canEditWorkOrder: true, canDeleteWorkOrder: true,
        canRecordProduction: true, canDeleteProduction: true, canRecordDowntime: true, canDeleteDowntime: true,
        canRecordNCR: true, canDeleteNCR: true, canApproveItem: true, canBlockItem: true,
        canCreateModel: true, canEditModel: true, canDeleteModel: true, canManageOperators: true,
        canManageEmployees: true, canExportReports: true, canViewAllData: true, canMarkAsFinished: true
    },
    [ROLES.TOP_MANAGEMENT]: {
        canViewDashboard: true, canViewReports: true, canViewWorkOrders: false, canViewProduction: false,
        canViewDowntime: false, canViewNCR: false, canViewHR: false, canViewModels: false, canViewSettings: false,
        canManageUsers: false, canCreateWorkOrder: false, canEditWorkOrder: false, canDeleteWorkOrder: false,
        canRecordProduction: false, canDeleteProduction: false, canRecordDowntime: false, canDeleteDowntime: false,
        canRecordNCR: false, canDeleteNCR: false, canApproveItem: false, canBlockItem: false,
        canCreateModel: false, canEditModel: false, canDeleteModel: false, canManageOperators: false,
        canManageEmployees: false, canExportReports: true, canViewAllData: true, canMarkAsFinished: false
    },
    [ROLES.PLANNING]: {
        canViewDashboard: true, canViewReports: true, canViewWorkOrders: false, canViewProduction: false,
        canViewDowntime: false, canViewNCR: false, canViewHR: false, canViewModels: false, canViewSettings: false,
        canManageUsers: false, canCreateWorkOrder: false, canEditWorkOrder: false, canDeleteWorkOrder: false,
        canRecordProduction: false, canDeleteProduction: false, canRecordDowntime: false, canDeleteDowntime: false,
        canRecordNCR: false, canDeleteNCR: false, canApproveItem: false, canBlockItem: false,
        canCreateModel: false, canEditModel: false, canDeleteModel: false, canManageOperators: false,
        canManageEmployees: false, canExportReports: true, canViewAllData: true, canMarkAsFinished: false
    },
    [ROLES.PRODUCTION]: {
        canViewDashboard: true, canViewReports: true, canViewWorkOrders: true, canViewProduction: true,
        canViewDowntime: true, canViewNCR: true, canViewHR: true, canViewModels: true, canViewSettings: false,
        canManageUsers: false, canCreateWorkOrder: true, canEditWorkOrder: true, canDeleteWorkOrder: true,
        canRecordProduction: true, canDeleteProduction: true, canRecordDowntime: true, canDeleteDowntime: true,
        canRecordNCR: true, canDeleteNCR: true, canApproveItem: false, canBlockItem: false,
        canCreateModel: true, canEditModel: true, canDeleteModel: true, canManageOperators: true,
        canManageEmployees: true, canExportReports: true, canViewAllData: true, canMarkAsFinished: false
    },
    [ROLES.QC]: {
        canViewDashboard: true, canViewReports: true, canViewWorkOrders: false, canViewProduction: false,
        canViewDowntime: false, canViewNCR: true, canViewHR: false, canViewModels: false, canViewSettings: false,
        canManageUsers: false, canCreateWorkOrder: false, canEditWorkOrder: false, canDeleteWorkOrder: false,
        canRecordProduction: false, canDeleteProduction: false, canRecordDowntime: false, canDeleteDowntime: false,
        canRecordNCR: true, canDeleteNCR: true, canApproveItem: false, canBlockItem: false,
        canCreateModel: false, canEditModel: false, canDeleteModel: false, canManageOperators: false,
        canManageEmployees: false, canExportReports: true, canViewAllData: false, canMarkAsFinished: false
    },
    [ROLES.PROJECTS]: {
        canViewDashboard: true, canViewReports: true, canViewWorkOrders: false, canViewProduction: false,
        canViewDowntime: false, canViewNCR: false, canViewHR: false, canViewModels: false, canViewSettings: false,
        canManageUsers: false, canCreateWorkOrder: false, canEditWorkOrder: false, canDeleteWorkOrder: false,
        canRecordProduction: false, canDeleteProduction: false, canRecordDowntime: false, canDeleteDowntime: false,
        canRecordNCR: false, canDeleteNCR: false, canApproveItem: false, canBlockItem: false,
        canCreateModel: false, canEditModel: false, canDeleteModel: false, canManageOperators: false,
        canManageEmployees: false, canExportReports: true, canViewAllData: true, canMarkAsFinished: false
    }
};

let currentUser = null;

// ============= USERS MANAGEMENT =============
async function loadUsers() {
    try {
        const data = await loadFromServer('usersDB');
        usersDB = Array.isArray(data) ? data : [];
        if (usersDB.length === 0) {
            usersDB = [
                { username: 'admin', password: 'admin123', role: 'administrator' },
                { username: 'planning', password: 'planning123', role: 'planning' },
                { username: 'production', password: 'production123', role: 'production' },
                { username: 'qc', password: 'qc123', role: 'qc' },
                { username: 'projects', password: 'projects123', role: 'projects' },
                { username: 'top', password: 'top123', role: 'top_management' }
            ];
            try { await saveUsersToServer(); } catch (e) { }
        }
    } catch (error) {
        console.error('Error loading users from server:', error);
        usersDB = [
            { username: 'admin', password: 'admin123', role: 'administrator' },
            { username: 'planning', password: 'planning123', role: 'planning' },
            { username: 'production', password: 'production123', role: 'production' },
            { username: 'qc', password: 'qc123', role: 'qc' },
            { username: 'projects', password: 'projects123', role: 'projects' },
            { username: 'top', password: 'top123', role: 'top_management' }
        ];
    }
}

async function saveUsersToServer() { await saveToServer('usersDB', usersDB); }
function findUser(username) { return usersDB.find(u => u.username.toLowerCase() === username.toLowerCase()); }
function authenticateUser(username, password) {
    const user = findUser(username);
    if (user && user.password === password) return user;
    return null;
}

// ============= LOGIN FUNCTIONS =============
function login(username, password) {
    const user = authenticateUser(username, password);
    if (!user) { showToast('اسم المستخدم أو كلمة المرور غير صحيحة', 'error'); return false; }
    currentUser = { username: user.username, role: user.role };
    localStorage.setItem('currentUser', JSON.stringify(currentUser));
    applyPermissions();
    renderAll();
    showToast('مرحباً ' + user.username, 'success');
    return true;
}

function logout() {
    currentUser = null;
    localStorage.removeItem('currentUser');
    document.getElementById('loginScreen').style.display = 'flex';
    document.querySelector('.fixed-header').style.display = 'none';
    document.querySelector('.sidebar').style.display = 'none';
    document.querySelector('.main-content').style.display = 'none';
    document.querySelector('.app-footer').style.display = 'none';
    document.querySelectorAll('section[id$="Section"]').forEach(s => s.classList.add('hidden'));
    showToast('تم تسجيل الخروج', 'info');
}

function getCurrentUser() {
    if (!currentUser) {
        const saved = localStorage.getItem('currentUser');
        if (saved) currentUser = JSON.parse(saved);
    }
    return currentUser;
}

function hasPermission(permission) {
    const user = getCurrentUser();
    if (!user) return false;
    const perms = PERMISSIONS[user.role];
    return perms && perms[permission] === true;
}

// ============= ENTRY PANELS =============
const ENTRY_PANEL_AUTO_CLOSE = true;
const ENTRY_PANELS = {
    models:    { panel: 'modelsEntryPanel',     btn: 'modelsNewBtn',     permission: 'canCreateModel',      focus: 'towerType' },
    workOrder: { panel: 'workOrderEntryPanel',  btn: 'workOrderNewBtn',  permission: 'canCreateWorkOrder',  focus: 'workOrderName' },
    production:{ panel: 'productionEntryPanel', btn: 'productionNewBtn', permission: 'canRecordProduction', focus: 'productionTowerType' },
    downtime:  { panel: 'downtimeEntryPanel',   btn: 'downtimeNewBtn',   permission: 'canRecordDowntime',   focus: 'downtimeShift' },
    ncr:       { panel: 'ncrEntryPanel',        btn: 'ncrNewBtn',        permission: 'canRecordNCR',        focus: 'ncrShift' }
};

function setEntryPanelState(key, open) {
    const cfg = ENTRY_PANELS[key];
    if (!cfg) return;
    const panel = document.getElementById(cfg.panel);
    const btn = document.getElementById(cfg.btn);
    if (panel) panel.classList.toggle('hidden', !open);
    if (btn) {
        btn.classList.toggle('open', open);
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        const icon = btn.querySelector('.entry-icon');
        if (icon) { icon.classList.toggle('fa-plus', !open); icon.classList.toggle('fa-xmark', open); }
        const lblNew = btn.querySelector('.entry-lbl-new');
        const lblClose = btn.querySelector('.entry-lbl-close');
        if (lblNew) lblNew.classList.toggle('hidden', open);
        if (lblClose) lblClose.classList.toggle('hidden', !open);
    }
}

function openEntryPanel(key) {
    const cfg = ENTRY_PANELS[key];
    if (!cfg) return;
    if (!hasPermission(cfg.permission)) { showToast('غير مسموح لك بإضافة سجل جديد', 'error'); return; }
    setEntryPanelState(key, true);
    const panel = document.getElementById(cfg.panel);
    setTimeout(() => {
        const first = document.getElementById(cfg.focus);
        if (first && typeof first.focus === 'function') first.focus({ preventScroll: true });
        if (panel && typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 60);
}

function closeEntryPanel(key) { setEntryPanelState(key, false); }

function toggleEntryPanel(key) {
    const cfg = ENTRY_PANELS[key];
    if (!cfg) return;
    const panel = document.getElementById(cfg.panel);
    if (panel && !panel.classList.contains('hidden')) closeEntryPanel(key); else openEntryPanel(key);
}

function syncEntryPanelPermission(key) {
    const cfg = ENTRY_PANELS[key];
    if (!cfg) return;
    const allowed = hasPermission(cfg.permission);
    const btn = document.getElementById(cfg.btn);
    if (btn) btn.style.display = allowed ? '' : 'none';
    if (!allowed) closeEntryPanel(key);
}

// ✅ v2.4.1 — Toggle manual production form panel; closes Excel panel when opening
function toggleProductionEntryPanel() {
    const panel = document.getElementById('productionEntryPanel');
    if (!panel) return;
    const isOpening = panel.classList.contains('hidden');
    toggleEntryPanel('production');
    if (isOpening) {
        const excelPanel = document.getElementById('productionExcelPanel');
        if (excelPanel && !excelPanel.classList.contains('hidden')) {
            toggleProductionExcelPanel();
        }
    }
}

function applyPermissionsToCurrentSection() {
    const visibleSection = document.querySelector('section:not(.hidden)');
    if (!visibleSection) return;
    const sectionId = visibleSection.id;
    switch (sectionId) {
        case 'modelsSection':
            const modelsForm = document.querySelector('#modelsSection .card:first-child .card-body .grid .lg\\:col-span-2 form');
            if (modelsForm) modelsForm.style.display = hasPermission('canCreateModel') ? '' : 'none';
            syncEntryPanelPermission('models');
            break;
        case 'workOrderSection':
            const woForm = document.querySelector('#workOrderSection .card:first-child .card-body .grid .lg\\:col-span-2 form');
            if (woForm) woForm.style.display = hasPermission('canCreateWorkOrder') ? '' : 'none';
            syncEntryPanelPermission('workOrder');
            break;
        case 'productionSection':
            const prodForm = document.querySelector('#productionEntryPanel form#productionForm');
            if (prodForm) prodForm.style.display = hasPermission('canRecordProduction') ? '' : 'none';
            const manageOpsBtn = document.querySelector('#productionSection button[onclick="showOperatorsManagement()"]');
            if (manageOpsBtn) manageOpsBtn.style.display = hasPermission('canManageOperators') ? '' : 'none';
            const excelBtn = document.getElementById('productionExcelToggleBtn');
            if (excelBtn) excelBtn.style.display = hasPermission('canRecordProduction') ? '' : 'none';
            syncEntryPanelPermission('production');
            break;
        case 'downtimeSection':
            const dtForm = document.querySelector('#downtimeSection .card:first-child .card-body .grid .lg\\:col-span-2 form');
            if (dtForm) dtForm.style.display = hasPermission('canRecordDowntime') ? '' : 'none';
            syncEntryPanelPermission('downtime');
            break;
        case 'ncrSection':
            const ncrForm = document.querySelector('#ncrSection .card:first-child .card-body .grid .lg\\:col-span-2 form');
            if (ncrForm) ncrForm.style.display = hasPermission('canRecordNCR') ? '' : 'none';
            syncEntryPanelPermission('ncr');
            break;
        case 'hrSection':
            const hrForm = document.querySelector('#hrSection .card:first-child .card-body .grid .lg\\:col-span-2 form');
            if (hrForm) hrForm.style.display = hasPermission('canManageEmployees') ? '' : 'none';
            break;
        case 'reportsSection':
            const exportBtns = document.querySelector('#reportResults .report-header .flex');
            if (exportBtns) {
                const btns = exportBtns.querySelectorAll('button:not(:last-child)');
                btns.forEach(btn => { btn.style.display = hasPermission('canExportReports') ? '' : 'none'; });
            }
            break;
    }
}

function applyPermissions() {
    const user = getCurrentUser();
    if (!user) {
        document.querySelector('.fixed-header').style.display = 'none';
        document.querySelector('.sidebar').style.display = 'none';
        document.querySelector('.main-content').style.display = 'none';
        document.querySelector('.app-footer').style.display = 'none';
        document.getElementById('loginScreen').style.display = 'flex';
        return;
    }
    document.querySelector('.fixed-header').style.display = 'flex';
    document.querySelector('.sidebar').style.display = 'block';
    document.querySelector('.main-content').style.display = 'block';
    document.querySelector('.app-footer').style.display = 'block';
    document.getElementById('loginScreen').style.display = 'none';

    document.querySelectorAll('.sidebar-tab').forEach(tab => {
        const tabId = tab.getAttribute('data-tab');
        if (!tabId) return;
        let visible = true;
        switch (tabId) {
            case 'dashboard': visible = hasPermission('canViewDashboard'); break;
            case 'models': visible = hasPermission('canViewModels'); break;
            case 'workOrder': visible = hasPermission('canViewWorkOrders'); break;
            case 'production': visible = hasPermission('canViewProduction'); break;
            case 'downtime': visible = hasPermission('canViewDowntime'); break;
            case 'ncr': visible = hasPermission('canViewNCR'); break;
            case 'hr': visible = hasPermission('canViewHR'); break;
            case 'reports': visible = hasPermission('canViewReports'); break;
            case 'settings': visible = hasPermission('canViewSettings'); break;
            default: visible = true;
        }
        tab.style.display = visible ? '' : 'none';
    });

    const recordProdBtn = document.querySelector('#productionForm button[onclick="recordProduction()"]');
    if (recordProdBtn) {
        recordProdBtn.disabled = !hasPermission('canRecordProduction');
        recordProdBtn.style.opacity = hasPermission('canRecordProduction') ? 1 : 0.5;
    }
    const machineSelect = document.getElementById('productionMachine');
    if (machineSelect) machineSelect.disabled = !hasPermission('canRecordProduction');
    const operatorSelect = document.getElementById('productionOperatorSelect');
    if (operatorSelect) operatorSelect.disabled = !hasPermission('canRecordProduction');
    const quantityInput = document.getElementById('productionQuantity');
    if (quantityInput) quantityInput.disabled = !hasPermission('canRecordProduction');

    const recordDtnBtn = document.querySelector('#downtimeForm button[onclick="recordDowntime()"]');
    if (recordDtnBtn) {
        recordDtnBtn.disabled = !hasPermission('canRecordDowntime');
        recordDtnBtn.style.opacity = hasPermission('canRecordDowntime') ? 1 : 0.5;
    }
    const recordNcrBtn = document.querySelector('#ncrForm button[onclick="recordNCR()"]');
    if (recordNcrBtn) {
        recordNcrBtn.disabled = !hasPermission('canRecordNCR');
        recordNcrBtn.style.opacity = hasPermission('canRecordNCR') ? 1 : 0.5;
    }
    applyPermissionsToCurrentSection();
}

function renderAll() {
    renderDashboard();
    renderModelsList();
    renderWorkOrdersList();
    renderProductionList();
    renderDowntimeList();
    renderNCRList();
    renderEmployeesList();
    updateStats();
    populateTowerTypeDropdown();
    populateProductionTowerTypeDropdown();
    populateDailyReportWorkOrders();
    populateNCRWorkOrders();
    populateReportDropdowns();
    populateShortageWorkOrders();
    populateWorkOrdersForOperation();
    updateOperatorsDropdown();
    switchTab('dashboard');
}

function handleLogin() {
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value.trim();
    if (!username || !password) { showToast('الرجاء إدخال اسم المستخدم وكلمة المرور', 'warning'); return; }
    const success = login(username, password);
    if (success) {
        if (!dataReady) { loadData().then(() => renderAll()); }
        else { renderAll(); }
    }
}

// ============= SERVER COMMUNICATION =============
function getLocalDateStr(d = new Date()) {
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().split('T')[0];
}

function getYesterdayDateStr() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return getLocalDateStr(d);
}

async function saveToServer(dataType, data) {
    if (!dataReady) { showToast('⛔ الحفظ معطّل: لم يتم تحميل البيانات من الخادم بعد.', 'error'); return { success: false, error: 'data not loaded' }; }
    lastSavePayload[dataType] = JSON.stringify(data);
    unconfirmedTypes.add(dataType);
    pendingSaves++;
    try {
        const response = await fetch(`${SERVER_URL}/api/data/${dataType}`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: lastSavePayload[dataType]
        });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const result = await response.json();
        if (!result.success) showToast('Error saving data: ' + (result.error || 'Unknown error'), 'error');
        else unconfirmedTypes.delete(dataType);
        return result;
    } catch (error) {
        console.error('Error saving to server:', error);
        showToast('Error connecting to server: ' + error.message, 'error');
        return { success: false, error: error.message };
    } finally { pendingSaves--; }
}

function flushUnsavedOnClose() {
    if (!dataReady) return;
    unconfirmedTypes.forEach(dataType => {
        const payload = lastSavePayload[dataType];
        if (payload === undefined) return;
        try {
            const blob = new Blob([payload], { type: 'application/json' });
            navigator.sendBeacon(`${SERVER_URL}/api/data/${dataType}`, blob);
        } catch (e) { console.error('flushUnsavedOnClose failed for', dataType, e); }
    });
    try {
        const pendingProd = productionDB.filter(r => !syncedRecordIds.has(r.id));
        if (pendingProd.length) {
            const blob = new Blob([JSON.stringify(pendingProd)], { type: 'application/json' });
            navigator.sendBeacon(`${SERVER_URL}/api/production`, blob);
        }
    } catch (e) { console.error('flushUnsavedOnClose (production) failed', e); }
}

function setupSaveOnClose() {
    window.addEventListener('pagehide', flushUnsavedOnClose);
    window.addEventListener('beforeunload', (e) => {
        flushUnsavedOnClose();
        if (pendingSaves > 0 || unconfirmedTypes.size > 0) {
            e.preventDefault();
            e.returnValue = 'جاري حفظ آخر البيانات — انتظر لحظة قبل الإغلاق.';
            return e.returnValue;
        }
    });
}

async function loadFromServer(dataType) {
    const response = await fetch(`${SERVER_URL}/api/data/${dataType}`);
    if (response.status === 404) {
        const emptyObjTypes = ['machineOperatorsDB', 'productionPreferences', 'appSettings', 'machineIdealRates', 'usersDB'];
        return emptyObjTypes.includes(dataType) ? {} : [];
    }
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status} for ${dataType}`);
    return await response.json();
}

async function loadProductionRecords() {
    const response = await fetch(`${SERVER_URL}/api/production/all`);
    if (response.ok) {
        const arr = await response.json();
        syncedRecordIds = new Set((arr || []).map(r => r.id));
        return arr || [];
    }
    if (response.status === 404) {
        const arr = (await loadFromServer('productionDB')) || [];
        syncedRecordIds = new Set(arr.map(r => r.id));
        return arr;
    }
    throw new Error(`HTTP error! status: ${response.status} for production records`);
}

async function flushNewProductionRecords() {
    if (!dataReady) { showToast('⛔ الحفظ معطّل.', 'error'); return { success: false, error: 'data not loaded' }; }
    const pending = productionDB.filter(r => !syncedRecordIds.has(r.id));
    if (pending.length === 0) return { success: true, inserted: 0 };
    try {
        const response = await fetch(`${SERVER_URL}/api/production`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pending)
        });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const result = await response.json();
        if (result.success) pending.forEach(r => syncedRecordIds.add(r.id));
        else showToast('Error saving production: ' + (result.error || 'Unknown error'), 'error');
        return result;
    } catch (error) {
        console.error('Error saving production records:', error);
        showToast('Error connecting to server: ' + error.message, 'error');
        return { success: false, error: error.message };
    }
}

async function deleteProductionRecordOnServer(recId) {
    if (!dataReady) return { success: false, error: 'data not loaded' };
    try {
        const response = await fetch(`${SERVER_URL}/api/production/${encodeURIComponent(recId)}`, { method: 'DELETE' });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const result = await response.json();
        syncedRecordIds.delete(recId);
        return result;
    } catch (error) {
        console.error('Error deleting production record:', error);
        showToast('Error connecting to server: ' + error.message, 'error');
        return { success: false, error: error.message };
    }
}

async function replaceAllProductionRecordsOnServer() {
    if (!dataReady) return { success: false, error: 'data not loaded' };
    try {
        const response = await fetch(`${SERVER_URL}/api/production/replace-all`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(productionDB)
        });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const result = await response.json();
        syncedRecordIds = new Set(productionDB.map(r => r.id));
        return result;
    } catch (error) {
        console.error('Error replacing production records:', error);
        showToast('Error connecting to server: ' + error.message, 'error');
        return { success: false, error: error.message };
    }
}

async function createProductionRecordsForArchivedOrders() {
    let createdCount = 0;
    workOrdersDB.forEach(wo => {
        if (wo.archived === true) {
            const existingProd = productionDB.some(r => r.workOrderId === wo.id);
            if (!existingProd) {
                wo.items.forEach(item => {
                    const completedQty = item.completedQuantity || item.quantity || 0;
                    const weightPerPiece = item.weightPerPiece || 0;
                    const totalWeight = completedQty * weightPerPiece;
                    if (completedQty > 0 && weightPerPiece > 0) {
                        const prodRec = {
                            id: Date.now() + Math.random(),
                            workOrderId: wo.id, workOrderName: wo.workOrderName,
                            projectName: wo.projectName, towerType: wo.type, model: wo.model,
                            shift: 'Finished', machine: 'System', operator: 'System',
                            date: wo.date || new Date().toISOString().split('T')[0],
                            itemName: item.itemName, itemSection: item.section, operation: 'Finished',
                            quantity: completedQty, rejectedQty: 0,
                            producedWeight: totalWeight, weightPerPiece: weightPerPiece,
                            totalItemWeight: item.totalWeight || totalWeight,
                            notes: 'Auto-generated from archived work order',
                            timestamp: Date.now(), recordedBy: 'system'
                        };
                        productionDB.push(prodRec);
                        createdCount++;
                    }
                });
            }
        }
    });
    if (createdCount > 0) await flushNewProductionRecords();
    return createdCount;
}

async function convertArchivedToFinished() {
    if (!hasPermission('canMarkAsFinished')) { showToast('❌ غير مسموح لك بنقل الأوامر المؤرشفة.', 'error'); return; }
    let count = 0;
    workOrdersDB.forEach(wo => { if (wo.archived === true) count++; });
    if (count === 0) { showToast('لا توجد أوامر عمل في الأرشيف', 'info'); return; }
    if (confirm(`هل أنت متأكد من نقل ${count} أمر عمل من Archived إلى Finished Work Orders؟`)) {
        await saveToServer('workOrdersDB', workOrdersDB);
        await createProductionRecordsForArchivedOrders();
        renderWorkOrdersList(); renderDashboard();
        populateProductionTowerTypeDropdown(); populateDailyReportWorkOrders();
        populateNCRWorkOrders(); populateReportDropdowns();
        populateShortageWorkOrders(); populateWorkOrdersForOperation();
    }
}

function repairLegacyCompletedQuantities() {
    let repairedCount = 0;
    workOrdersDB.forEach(wo => {
        (wo.items || []).forEach(item => {
            if (!item.operations || item.operations.length === 0) return;
            const before = item.completedQuantity || 0;
            const after = recalcItemCompletedQuantity(item);
            if (before !== after) { item.completedQuantity = after; repairedCount++; }
            let allComplete = true, anyCompleted = false;
            item.operations.forEach(op => {
                const comp = item.completedOperations ? item.completedOperations[op.name] : null;
                const qty = comp ? (parseInt(comp.completedQuantity) || 0) : 0;
                if (qty < item.quantity) allComplete = false;
                if (qty > 0) anyCompleted = true;
            });
            if (item.status !== 'Blocked') {
                if (allComplete && item.completedQuantity >= item.quantity) item.status = STATUS.COMPLETED;
                else if (anyCompleted) item.status = STATUS.IN_PROGRESS;
                else item.status = STATUS.PENDING;
            }
        });
    });
    if (repairedCount > 0) console.log(`🔧 تم إصلاح completedQuantity لـ ${repairedCount} بند`);
    return repairedCount;
}

function repairLegacyGalvanizingOperations() {
    let cleanedCount = 0;
    workOrdersDB.forEach(wo => {
        (wo.items || []).forEach(item => {
            if (!item.operations || item.operations.length === 0) return;
            const hasGalv = item.operations.some(op => isGalvanizingOperation(op));
            const keptBeforeReorder = item.operations.filter(op => !isGalvanizingOperation(op));
            const lastIdx = keptBeforeReorder.length - 1;
            const finishPositions = keptBeforeReorder.map((op, i) => isFinishOperation(op) ? i : -1).filter(i => i >= 0);
            const lastFinishPos = finishPositions.length ? finishPositions[finishPositions.length - 1] : -1;
            const needsReorder = lastFinishPos !== -1 && lastFinishPos !== lastIdx;
            if (!hasGalv && !needsReorder) return;
            if (hasGalv && item.completedOperations) {
                item.operations.forEach(op => {
                    if (isGalvanizingOperation(op) && item.completedOperations[op.name]) delete item.completedOperations[op.name];
                });
            }
            item.operations = normalizeItemOperations(item.operations);
            item.completedQuantity = recalcItemCompletedQuantity(item);
            recalcItemStatus(item);
            cleanedCount++;
        });
    });
    if (cleanedCount > 0) console.log(`🔧 تم تنظيف ${cleanedCount} بند`);
    return cleanedCount;
}

async function loadData() {
    try {
        db = await loadFromServer('towerDB');
        workOrdersDB = await loadFromServer('workOrdersDB');
        workOrdersDB.forEach(wo => { if (wo.archived === undefined) wo.archived = false; });
        const repairedQty = repairLegacyCompletedQuantities();
        const repairedGalv = repairLegacyGalvanizingOperations();
        if (repairedQty > 0 || repairedGalv > 0) {
            try { await saveToServer('workOrdersDB', workOrdersDB); } catch (e) { }
        }
        let archivedCount = 0;
        workOrdersDB.forEach(wo => { if (wo.archived === true) archivedCount++; });
        if (archivedCount > 0) {
            await saveToServer('workOrdersDB', workOrdersDB);
            await createProductionRecordsForArchivedOrders();
        }
        productionDB = await loadProductionRecords();
        const operatorsData = await loadFromServer('machineOperatorsDB');
        machineOperatorsDB = operatorsData || {};
        const preferencesData = await loadFromServer('productionPreferences');
        productionPreferences = preferencesData || { towerType: '', model: '', workOrderId: '', shift: '', machine: '', operator: '', date: new Date().toISOString().split('T')[0] };
        downtimeDB = await loadFromServer('downtimeDB');
        machineIdealRates = await loadFromServer('machineIdealRates');
        ncrDB = await loadFromServer('ncrDB');
        employeesDB = await loadFromServer('employeesDB');
        await loadUsers();
        dataReady = true;
    } catch (error) {
        console.error('Error loading data:', error);
        dataReady = false;
        alert('⚠ تعذّر تحميل البيانات من الخادم.\n\nتأكد من تشغيل الخادم (' + SERVER_URL + ') ثم أعد فتح البرنامج.');
        showToast('تعذّر الاتصال بالخادم — الحفظ معطّل لحماية البيانات', 'error');
    }
}

async function saveAllData() {
    try {
        await saveToServer('towerDB', db);
        await saveToServer('workOrdersDB', workOrdersDB);
        await replaceAllProductionRecordsOnServer();
        await saveToServer('machineOperatorsDB', machineOperatorsDB);
        await saveToServer('productionPreferences', productionPreferences);
        await saveToServer('appSettings', JSON.stringify(appConfig.settings));
        await saveToServer('downtimeDB', downtimeDB);
        await saveToServer('machineIdealRates', machineIdealRates);
        await saveToServer('ncrDB', ncrDB);
        await saveToServer('employeesDB', employeesDB);
        await saveUsersToServer();
    } catch (error) {
        console.error('Error saving data:', error);
        showToast('Error saving data to storage', 'error');
    }
}

// ============= SETTINGS =============
function showSettingsPanel() {
    if (!hasPermission('canViewSettings')) { showToast('غير مسموح لك بالوصول إلى الإعدادات', 'error'); return; }
    showModal('settingsModal');
    if (hasPermission('canManageUsers')) renderUsersManagement();
    else {
        const usersSection = document.getElementById('usersManagementContainer');
        if (usersSection) usersSection.innerHTML = '';
    }
}

function renderUsersManagement() {
    const container = document.getElementById('usersManagementContainer');
    if (!container) return;
    let html = `<div class="card p-4 mt-4 border-t-2 border-indigo-200"><h3 class="text-lg font-bold mb-4"><i class="fa-solid fa-users-gear mr-2 text-indigo-600"></i> إدارة المستخدمين</h3><div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4"><div class="input-group"><label class="input-label">اسم المستخدم</label><input type="text" id="newUsername" class="input-field" placeholder="أدخل اسم المستخدم"></div><div class="input-group"><label class="input-label">كلمة المرور</label><input type="password" id="newPassword" class="input-field" placeholder="أدخل كلمة المرور"></div><div class="input-group"><label class="input-label">الدور</label><select id="newUserRole" class="input-field"><option value="administrator">مدير النظام</option><option value="planning">التخطيط</option><option value="production">الإنتاج</option><option value="qc">الجودة</option><option value="projects">المشروعات</option><option value="top_management">الإدارة العليا</option></select></div><div class="flex items-end"><button onclick="addUser()" class="btn btn-primary w-full"><i class="fa-solid fa-user-plus"></i> إضافة مستخدم</button></div></div><div class="table-container"><table class="table report-table"><thead><tr><th>#</th><th>اسم المستخدم</th><th>الدور</th><th>إجراءات</th></tr></thead><tbody id="usersTableBody"></tbody></table></div></div>`;
    container.innerHTML = html;
    renderUsersTable();
}

function renderUsersTable() {
    const tbody = document.getElementById('usersTableBody');
    if (!tbody) return;
    if (usersDB.length === 0) { tbody.innerHTML = '<tr><td colspan="4" class="text-center py-4">لا يوجد مستخدمين</td></tr>'; return; }
    let rows = '';
    usersDB.forEach((user, index) => {
        const roleNames = { administrator: 'مدير النظام', planning: 'التخطيط', production: 'الإنتاج', qc: 'الجودة', projects: 'المشروعات', top_management: 'الإدارة العليا' };
        rows += `<tr><td class="text-center">${index + 1}</td><td class="font-bold">${esc(user.username)}</td><td class="text-center"><span class="badge badge-info">${roleNames[user.role] || user.role}</span></td><td class="text-center"><button onclick="editUser('${esc(user.username)}')" class="btn btn-sm btn-outline"><i class="fa-solid fa-edit"></i></button> <button onclick="deleteUser('${esc(user.username)}')" class="btn btn-sm btn-danger"><i class="fa-solid fa-trash"></i></button></td></tr>`;
    });
    tbody.innerHTML = rows;
}

async function addUser() {
    const username = document.getElementById('newUsername').value.trim();
    const password = document.getElementById('newPassword').value.trim();
    const role = document.getElementById('newUserRole').value;
    if (!username || !password) { showToast('الرجاء إدخال اسم المستخدم وكلمة المرور', 'warning'); return; }
    if (findUser(username)) { showToast('اسم المستخدم موجود بالفعل', 'error'); return; }
    usersDB.push({ username, password, role });
    await saveUsersToServer();
    renderUsersTable();
    document.getElementById('newUsername').value = '';
    document.getElementById('newPassword').value = '';
    showToast('تم إضافة المستخدم بنجاح', 'success');
}

async function deleteUser(username) {
    if (username === 'admin') { showToast('لا يمكن حذف المستخدم الرئيسي', 'error'); return; }
    if (!confirm(`هل أنت متأكد من حذف المستخدم "${username}"؟`)) return;
    const idx = usersDB.findIndex(u => u.username === username);
    if (idx === -1) return;
    usersDB.splice(idx, 1);
    await saveUsersToServer();
    renderUsersTable();
    showToast('تم حذف المستخدم بنجاح', 'success');
}

async function editUser(username) {
    const user = findUser(username);
    if (!user) return;
    const newPassword = prompt(`تعديل كلمة المرور للمستخدم "${username}":`, '');
    if (newPassword === null) return;
    if (newPassword.trim() !== '') {
        user.password = newPassword.trim();
        await saveUsersToServer();
        renderUsersTable();
        showToast('تم تحديث كلمة المرور بنجاح', 'success');
    }
}

// ============= TRANSLATIONS =============
const translations = {
    en: {
        appTitle: "Tower Manufacturing Management System ", appSubtitle: "66KV - 220KV - 500KV - Telecom ",
        manageOperators: "Manage Operators ", backup: "Backup ", database: "Database ", workOrders: "Work Orders ",
        dailyProduction: "Daily Production ", reports: "Reports ", settings: "Settings ", downtime: "Downtime ",
        dashboard: "Dashboard ", dashboardTitle: "Production Dashboard ", lastUpdated: "Last updated ",
        activeWorkOrders: "Active Work Orders ", totalDowntimeToday: "Downtime (Yesterday) ",
        productionToday: "Production (Yesterday) ", finishedWorkOrders: "Finished WOs ",
        minimumProgress: "Minimum Operations Progress ", finishingProgress: "Finishing Operations Progress ",
        totalRequired: "Total Required ", completedQty: "Completed ",
        minimumDesc: "Includes operations: Minimum, 206, 20.20, 10.10, 83P ",
        finishingDesc: "Includes operations: Finishing ",
        downtimeByType: "Downtime by Type ", totalDowntime: "Total Downtime ",
        recentDowntime: "Recent Downtime ", noData: "No data available ",
        modelsDatabase: "Models Database ", towerType: "Tower Type ", selectType: "Select type... ",
        modelName: "Model Name ", uploadExcelFile: "Upload Excel File ", clickToUpload: "Click to upload or drag & drop ",
        fileMustContain: "File must contain required columns ", processSaveData: "Process & Save Data ",
        importantInformation: "Important Information ", excelMustContain: "Excel file must contain these columns ",
        itemNameSection: "Item Name, Section, Steel Grade ", operations5to7: "Operations (5 to 7 operations) ",
        operationsProcessed: "Operations processed automatically ", statistics: "Statistics ",
        models: "Models ", items: "Items ", savedModels: "Saved Models ", searchModel: "Search model... ",
        noSavedModels: "No saved models. ", modelDetails: "Model Details ", close: "Close ",
        createNewWorkOrder: "Create New Work Order ",
        newModelBtn: "New Model", newWorkOrderBtn: "New Work Order", newDowntimeBtn: "New Downtime", newNCRBtn: "New NCR", newProductionBtn: "Add Daily Production",
        workOrdersManagement: "Work Orders Management", workOrderName: "Work Order Name ",
        projectName: "Project Name ", salesOrderNumber: "Sales Order Number ", uploadWorkOrderFile: "Upload Work Order File ",
        createWorkOrder: "Create Work Order ", notes: "Notes ", selectExistingModel: "Select existing model from database ",
        operationsImported: "Operations will be imported from selected model ",
        woFileMustContain: "Work order file must contain quantities & weights ",
        productionStatusUpdated: "Production status updated automatically ", workOrdersStatistics: "Work Orders Statistics ",
        searchWorkOrders: "Search work orders... ", noWorkOrders: "No work orders. ",
        exportExcel: "Excel ", generateReport: "Report ", workOrderDetails: "Work Order Details ",
        save: "Save ", clear: "Clear ", selectionsSaved: "Your selections will be saved automatically ",
        shift: "Shift ", selectShift: "Select shift... ", firstShift: "First Shift ", secondShift: "Second Shift ", thirdShift: "Third Shift ",
        machineName: "Machine Name ", selectMachine: "Select machine... ", operatorName: "Operator Name ", selectOperator: "Select operator... ",
        selectItemProduction: "Select Item for Production ", selectItem: "Select item... ", section: "Section ",
        operation: "Operation ", totalQty: "Total Qty ", completed: "Completed ", remaining: "Remaining ",
        weightPiece: "Weight/Piece ", quantityProduced: "Quantity Produced ", notesField: "Additional notes... ",
        recordProduction: "Record Production ", productionStatistics: "Production Statistics ",
        productionRecords: "Production Records ", piecesProduced: "Pieces Produced ",
        searchProduction: "Search production records... ", noProductionRecords: "No production records. ",
        showingLatestRecords: "Showing latest 10 production records. ", productionRecordDetails: "Production Record Details ",
        searchItem: "Search item... ", itemsStatusReport: "Items Status Report ",
        detailedStatus: "Get detailed status of items ", selectWorkOrder: "Select Work Order ",
        generateItemsStatus: "Generate Items Status Report ", detailedItemReport: "Detailed Item Report ",
        detailedProduction: "Production history for a specific item ", generateDetailed: "Generate Detailed Report ",
        dailyProductionReport: "Daily Production Report ", fromDate: "From Date ", toDate: "To Date ", allShifts: "All Shifts ",
        operationPhase: "Operation Phase ", allPhases: "All Phases ", allMachines: "All Machines ",
        generateDaily: "Generate Daily Production Report ", operationStatusReport: "Operation Status Report ",
        operationStatusDesc: "Status of a specific operation ", selectOperationPhase: "Select Operation Phase ",
        selectOperation: "Select operation... ", generateOperationStatus: "Generate Operation Status Report ",
        machineCategory: "Machine Category ", angles: "Angles ", plates: "Plates ", all: "All ",
        print: "Print ", exportPdf: "PDF ", stageSummaryReport: "Project Stage Summary ",
        stageSummaryDesc: "Completed vs in-progress per stage ", selectProject: "Select Project ",
        allProjects: "All Projects ", stage: "Stage ", generateStageSummary: "Generate Stage Summary ",
        selectSalesOrder: "Select Sales Order ", allSalesOrders: "All Sales Orders ",
        minStoppageReport: "WIP After Minimum", minStoppageDesc: "Items that completed Minimum and are still WIP ",
        stoppedAtStage: "Stopped At Stage ", welcome: "Welcome to Tower Manufacturing Management System! ",
        backupCreated: "Backup created successfully ", dataRestored: "Data restored successfully ",
        operatorsSaved: "Operators saved successfully ", preferencesSaved: "Preferences saved ",
        fileLoaded: "File loaded successfully ", woFileLoaded: "Work order file loaded ",
        modelSaved: "Model data saved successfully ", woProcessed: "Work order processed successfully ",
        productionRecorded: "Production recorded successfully ", fieldsCleared: "Fields cleared ",
        selectWOOp: "Please select work order and operation ", selectWO: "Please select work order ",
        selectWODate: "Please select date range ", inProgress: "In Progress ", completedStatus: "Completed ",
        pending: "Pending ", cropping: "Cropping ", manualPlasma: "Manual Plasma ", press: "Press ",
        drill: "Drill ", chamfering: "Chamfering ", shear: "Shear ", cncBending: "CNC Bending ",
        finishing: "Finishing ", length: "Length ", quantity: "Quantity ", totalWeight: "Total Weight ",
        weightProduced: "Weight Produced ", creationDate: "Creation Date ", salesOrder: "Sales Order ",
        project: "Project ", machine: "Machine ", operator: "Operator ",
        allWorkOrders: "All Work Orders ", inProgressWorkOrders: "In Progress Work Orders ",
        finishedOrders: "Finished Orders ", processing: "Processing... ",
        backupSchedule: "Backup Schedule ", setAutomaticBackup: "Set automatic backup timing ",
        saveSchedule: "Save Schedule ", backupManagement: "Backup Management ",
        delete: "Delete ", deleteRecord: "Delete Record ", deleteModel: "Delete Model ", deleteWorkOrder: "Delete Work Order ",
        confirmDelete: "Confirm Delete ", areYouSureDeleteModel: "Are you sure you want to delete this model? ",
        areYouSureDeleteWorkOrder: "Are you sure you want to delete this work order? ",
        areYouSureDeleteProduction: "Are you sure you want to delete this production record? ",
        areYouSureDeleteDowntime: "Are you sure you want to delete this downtime record? ",
        modelHasWorkOrders: "This model is linked to work orders and cannot be deleted ",
        workOrderHasProduction: "This work order has production records and cannot be deleted ",
        confirm: "Confirm ", cancel: "Cancel ", recordDeleted: "Record deleted successfully ",
        modelDeleted: "Model deleted successfully ", workOrderDeleted: "Work order deleted successfully ",
        productionDeleted: "Production record deleted successfully ", downtimeDeleted: "Downtime record deleted successfully ",
        selectReportType: "Select Report Type ", backupRestore: "Backup Management ",
        createBackup: "Create Backup ", saveAllData: "Save all system data to a JSON file ",
        restoreBackup: "Restore Backup ", restoreData: "Restore data from a backup file ",
        downtimeRecording: "Downtime Recording ", downtimeType: "Fault Type ",
        selectDowntimeType: "Select type... ", workerName: "Worker Name ", workerNamePlaceholder: "Enter worker name... ",
        maintenance: "Maintenance ", planningLoad: "Planning Load ", materialIssue: "Material Issue ",
        laborShortage: "Labor Shortage ", quality: "Quality ", description: "Description ",
        durationMinutes: "Duration (minutes) ", recordDowntime: "Record Downtime ", downtimeInfo: "Downtime Information ",
        downtimeHelp: "Record machine downtime for analysis ", downtimeHelp2: "Used for OEE calculations ",
        downtimeStats: "Downtime Statistics ", downtimeRecords: "Downtime Records ",
        searchDowntime: "Search downtime records... ", records: "Records ",
        shortageReport: "Shortage Report ", shortageDesc: "Items with remaining quantity > 0 ",
        generateShortage: "Generate Shortage Report ", remainingQty: "Remaining Qty ",
        downtimeReport: "Downtime Report ", generateDowntimeReport: "Generate Downtime Report ",
        showingLatestDowntimeRecords: "Showing latest 10 downtime records. ",
        oeeTitle: "Overall Equipment Effectiveness (OEE) ", oeeAvailability: "Availability ",
        oeePerformance: "Performance ", oeeQuality: "Quality ", oeeValue: "OEE ",
        manageIdealRates: "Set Machine Ideal Rates ", idealRate: "Ideal Rate (pcs/hour) ",
        rejectedQty: "Rejected Quantity ", goodQty: "Good Quantity ", saveIdealRates: "Save Ideal Rates ",
        ncrTitle: "Non-Conformance ", ncrType: "NCR Type ", scrap: "Scrap ",
        acceptAsIs: "Accept as it is ", repair: "Repair ", ncrComment: "Comment ",
        ncrCause: "NCR Cause ", recordNCR: "Record NCR ", ncrRecords: "NCR Records ",
        searchNCR: "Search NCR records... ", ncrDeleted: "NCR record deleted successfully ",
        areYouSureDeleteNCR: "Are you sure you want to delete this NCR record? ",
        teepTitle: "Total Effective Equipment Performance (TEEP) ", teepValue: "TEEP ",
        ncrReport: "NCR Report ", oeeReport: "OEE Report ", teepReport: "TEEP Report ",
        utilization: "Utilization ", totalProduction: "Total Production ", totalRejected: "Total Rejected ",
        hrTitle: "Workforce Management (HR) ", employeeName: "Employee Name ",
        employeeId: "Employee ID ", department: "Department ", position: "Position ", phone: "Phone ",
        hireDate: "Hire Date ", status: "Status ", saveEmployee: "Save Employee ", employeeList: "Employee List ",
        totalEmployees: "Total Employees ", activeEmployees: "Active ", hrNotes: "HR Notes ",
        employeeDeleted: "Employee deleted successfully ",
        areYouSureDeleteEmployee: "Are you sure you want to delete this employee? ",
        balanceComplete: "Complete as Balance ", monthlyProductionReport: "Monthly Production Report ",
        monthlyReportDesc: "Daily Minimum & Finish vs target (22 tons) ",
        month: "Month ", day: "Day ", date: "Date ", target: "Target (tons) ",
        actualMin: "Min (tons) ", actualFin: "Finish (tons) ", effMin: "Min Eff % ",
        effFin: "Finish Eff % ", cumEffMin: "Cum. Min Eff % ", cumEffFin: "Cum. Finish Eff % ",
        workingDay: "Working Day ", holiday: "Holiday ", generateMonthlyReport: "Generate Monthly Report ",
        logout: "Logout", loginTitle: "Login", username: "Username", password: "Password",
        role: "Role", loginButton: "Login", loginHint: "For testing: use any username and choose the appropriate role",
        usernamePlaceholder: "Enter username", passwordPlaceholder: "Enter password",
        rolePlanning: "Planning", roleProduction: "Production", roleQC: "Quality",
        roleProjects: "Projects", roleTopManagement: "Top Management", roleAdministrator: "Administrator",
        markAsFinished: "Mark as Finished",
        markAsFinishedConfirm: "Mark this work order as Finished? (≥90% complete)\nIncomplete items will remain and can be completed later.",
        minCompletionRequired: "Minimum 90% completion required to mark as finished",
        soFamilyTree: "Sales Order Family Tree",
        soFamilyTreeDesc: "Hierarchical tree for each Sales Order with its Work Orders and status ",
        treeSalesOrderFilter: "Sales Order",
        treeStatusFilter: "Status",
        treeViewStyle: "View Style",
        treeDetailView: "🌳 Detailed Tree (collapsible)",
        treeSummaryView: "📋 Summary (one row per Sales Order)",
        treeDelayDays: "Delay Threshold (days)",
        treeDelayBasis: "Delay Basis",
        treeBasisAge: "Days since work order creation",
        treeBasisIdle: "Days without production activity",
        treeStatusAll: "All",
        treeStatusInProgress: "In Progress Only",
        treeStatusFinished: "Finished Only",
        treeStatusDelayed: "Delayed Only",
        generateFamilyTree: "Generate Family Tree",
        noSalesOrdersMatch: "No Sales Orders match the current filter",
        noWorkOrdersMatchFilter: "No work orders match the current filter"
    },
    ar: {
        appTitle: "نظام إدارة تصنيع الأبراج ", appSubtitle: "66KV - 220KV - 500KV - الاتصالات ",
        manageOperators: "إدارة العاملين ", backup: "نسخ احتياطي ", database: "قاعدة البيانات ",
        workOrders: "أوامر العمل ", dailyProduction: "الإنتاج اليومي ", reports: "التقارير ",
        settings: "الإعدادات ", downtime: "التوقفات ", dashboard: "لوحة القيادة ",
        dashboardTitle: "لوحة قيادة الإنتاج ", lastUpdated: "آخر تحديث ",
        activeWorkOrders: "أوامر العمل النشطة ", totalDowntimeToday: "التوقف (أمس) ",
        productionToday: "الإنتاج (أمس) ", finishedWorkOrders: "أوامر العمل المنتهية ",
        minimumProgress: "تقدم عمليات التشغيل الأولي ", finishingProgress: "تقدم عمليات التشطيب ",
        totalRequired: "إجمالي المطلوب ", completedQty: "المكتمل ",
        minimumDesc: "يشمل عمليات: Minimum, 206, 20.20, 10.10, 83P ",
        finishingDesc: "يشمل عمليات: التشطيب ",
        downtimeByType: "التوقفات حسب النوع ", totalDowntime: "إجمالي التوقفات ",
        recentDowntime: "أحدث التوقفات ", noData: "لا توجد بيانات ",
        modelsDatabase: "قاعدة بيانات النماذج ", towerType: "نوع البرج ", selectType: "اختر النوع... ",
        modelName: "اسم النموذج ", uploadExcelFile: "رفع ملف Excel ", clickToUpload: "انقر للرفع أو اسحب وأفلت ",
        fileMustContain: "يجب أن يحتوي الملف على الأعمدة المطلوبة ", processSaveData: "معالجة وحفظ البيانات ",
        importantInformation: "معلومات مهمة ", excelMustContain: "يجب أن يحتوي ملف Excel على هذه الأعمدة ",
        itemNameSection: "اسم البند، القطاع، درجة الصلب ", operations5to7: "العمليات (5 إلى 7 عمليات) ",
        operationsProcessed: "معالجة العمليات تلقائياً ", statistics: "إحصائيات ",
        models: "نماذج ", items: "بنود ", savedModels: "النماذج المحفوظة ", searchModel: "بحث في النماذج... ",
        noSavedModels: "لا توجد نماذج محفوظة. ", modelDetails: "تفاصيل النموذج ", close: "إغلاق ",
        createNewWorkOrder: "إنشاء أمر عمل جديد ",
        newModelBtn: "نموذج جديد", newWorkOrderBtn: "أمر عمل جديد", newDowntimeBtn: "تسجيل توقف جديد", newNCRBtn: "تسجيل عدم مطابقة جديد", newProductionBtn: "إضافة إنتاج يومي",
        workOrdersManagement: "إدارة أوامر العمل", workOrderName: "اسم أمر العمل ",
        projectName: "اسم المشروع ", salesOrderNumber: "رقم أمر المبيعات ", uploadWorkOrderFile: "رفع ملف أمر العمل ",
        createWorkOrder: "إنشاء أمر العمل ", notes: "ملاحظات ", selectExistingModel: "اختر نموذجاً من قاعدة البيانات ",
        operationsImported: "سيتم استيراد العمليات من النموذج المحدد ",
        woFileMustContain: "يجب أن يحتوي ملف أمر العمل على الكميات والأوزان ",
        productionStatusUpdated: "يتم تحديث حالة الإنتاج تلقائياً ", workOrdersStatistics: "إحصائيات أوامر العمل ",
        searchWorkOrders: "بحث في أوامر العمل... ", noWorkOrders: "لا توجد أوامر عمل. ",
        exportExcel: "Excel ", generateReport: "تقرير ", workOrderDetails: "تفاصيل أمر العمل ",
        save: "حفظ ", clear: "مسح ", selectionsSaved: "سيتم حفظ اختياراتك تلقائياً ",
        shift: "الوردية ", selectShift: "اختر الوردية... ", firstShift: "الوردية الأولى ",
        secondShift: "الوردية الثانية ", thirdShift: "الوردية الثالثة ",
        machineName: "اسم الماكينة ", selectMachine: "اختر الماكينة... ",
        operatorName: "اسم العامل ", selectOperator: "اختر العامل... ",
        selectItemProduction: "اختر البند للإنتاج ", selectItem: "اختر البند... ", section: "القطاع ",
        operation: "العملية ", totalQty: "الكمية الكلية ", completed: "المكتمل ", remaining: "المتبقي ",
        weightPiece: "الوزن/قطعة ", quantityProduced: "الكمية المنتجة ", notesField: "ملاحظات إضافية... ",
        recordProduction: "تسجيل الإنتاج ", productionStatistics: "إحصائيات الإنتاج ",
        productionRecords: "سجلات الإنتاج ", piecesProduced: "القطع المنتجة ",
        searchProduction: "بحث في سجلات الإنتاج... ", noProductionRecords: "لم يتم العثور على سجلات إنتاج. ",
        showingLatestRecords: "عرض آخر 10 سجلات إنتاج. ", productionRecordDetails: "تفاصيل سجل الإنتاج ",
        searchItem: "ابحث عن البند... ", itemsStatusReport: "تقرير حالة البنود ",
        detailedStatus: "الحصول على حالة مفصلة للبنود ", selectWorkOrder: "اختر أمر العمل ",
        generateItemsStatus: "إنشاء تقرير حالة البنود ", detailedItemReport: "تقرير مفصل للبند ",
        detailedProduction: "الحصول على سجل إنتاج مفصل لبند محدد ", generateDetailed: "إنشاء تقرير مفصل ",
        dailyProductionReport: "تقرير الإنتاج اليومي ", fromDate: "من تاريخ ", toDate: "إلى تاريخ ", allShifts: "جميع الورديات ",
        operationPhase: "مرحلة العملية ", allPhases: "جميع المراحل ", allMachines: "جميع الماكينات ",
        generateDaily: "إنشاء تقرير الإنتاج اليومي ", operationStatusReport: "تقرير حالة العملية ",
        operationStatusDesc: "الحصول على حالة عملية محددة ", selectOperationPhase: "اختر مرحلة العملية ",
        selectOperation: "اختر العملية... ", generateOperationStatus: "إنشاء تقرير حالة العملية ",
        machineCategory: "فئة الماكينة ", angles: "زوايا ", plates: "صاج ", all: "الكل ",
        print: "طباعة ", exportPdf: "PDF ", stageSummaryReport: "ملخص مراحل المشروع ",
        stageSummaryDesc: "المكتمل مقابل ما تحت التشغيل ", selectProject: "اختر المشروع ",
        allProjects: "جميع المشاريع ", stage: "المرحلة ", generateStageSummary: "إنشاء ملخص المراحل ",
        selectSalesOrder: "اختر أمر المبيعات ", allSalesOrders: "جميع أوامر المبيعات ",
        minStoppageReport: "جاري العمل بعد المينمم ", minStoppageDesc: "بنود أنهت مرحلة المينمم ولم تكتمل في المراحل التالية ",
        stoppedAtStage: "المرحلة المتوقف عندها ", welcome: "مرحباً بكم في نظام إدارة تصنيع الأبراج! ",
        backupCreated: "تم إنشاء النسخ الاحتياطي بنجاح ", dataRestored: "تم استعادة البيانات بنجاح ",
        operatorsSaved: "تم حفظ العاملين بنجاح ", preferencesSaved: "تم حفظ التفضيلات ",
        fileLoaded: "تم تحميل الملف بنجاح ", woFileLoaded: "تم تحميل ملف أمر العمل ",
        modelSaved: "تم حفظ بيانات النموذج بنجاح ", woProcessed: "تم معالجة أمر العمل بنجاح ",
        productionRecorded: "تم تسجيل الإنتاج بنجاح ", fieldsCleared: "تم مسح الحقول ",
        selectWOOp: "يرجى اختيار أمر العمل والعملية ", selectWO: "يرجى اختيار أمر العمل ",
        selectWODate: "يرجى اختيار نطاق التاريخ ", inProgress: "قيد التنفيذ ", completedStatus: "مكتمل ",
        pending: "معلق ", cropping: "قص ", manualPlasma: "بلازما يدوي ", press: "مكبس ",
        drill: "مثقاب ", chamfering: "حشو ", shear: "قص الصاج ", cncBending: "ثني CNC ",
        finishing: "تشطيب ", length: "الطول ", quantity: "الكمية ", totalWeight: "الوزن الكلي ",
        weightProduced: "الوزن المنتج ", creationDate: "تاريخ الإنشاء ", salesOrder: "أمر المبيعات ",
        project: "المشروع ", machine: "الماكينة ", operator: "العامل ",
        allWorkOrders: "جميع أوامر العمل ", inProgressWorkOrders: "أوامر العمل الجاري ",
        finishedOrders: "أوامر العمل المنتهية ", processing: "جاري المعالجة... ",
        backupSchedule: "جدول النسخ الاحتياطي ", setAutomaticBackup: "تعيين توقيت النسخ الاحتياطي التلقائي ",
        saveSchedule: "حفظ الجدول ", backupManagement: "إدارة النسخ الاحتياطي ",
        delete: "حذف ", deleteRecord: "حذف السجل ", deleteModel: "حذف النموذج ", deleteWorkOrder: "حذف أمر الشغل ",
        confirmDelete: "تأكيد الحذف ", areYouSureDeleteModel: "هل أنت متأكد من حذف هذا النموذج؟ ",
        areYouSureDeleteWorkOrder: "هل أنت متأكد من حذف أمر الشغل هذا؟ ",
        areYouSureDeleteProduction: "هل أنت متأكد من حذف سجل الإنتاج هذا؟ ",
        areYouSureDeleteDowntime: "هل أنت متأكد من حذف سجل التوقف هذا؟ ",
        modelHasWorkOrders: "هذا النموذج مرتبط بأوامر شغل ولا يمكن حذفه ",
        workOrderHasProduction: "أمر الشغل هذا يحتوي على سجلات إنتاج ولا يمكن حذفه ",
        confirm: "تأكيد ", cancel: "إلغاء ", recordDeleted: "تم حذف السجل بنجاح ",
        modelDeleted: "تم حذف النموذج بنجاح ", workOrderDeleted: "تم حذف أمر الشغل بنجاح ",
        productionDeleted: "تم حذف سجل الإنتاج بنجاح ", downtimeDeleted: "تم حذف سجل التوقف بنجاح ",
        selectReportType: "اختر نوع التقرير ", backupRestore: "إدارة النسخ الاحتياطي ",
        createBackup: "إنشاء نسخة احتياطية ", saveAllData: "حفظ جميع بيانات النظام في ملف JSON ",
        restoreBackup: "استعادة النسخة الاحتياطية ", restoreData: "استعادة البيانات من ملف نسخ احتياطي ",
        downtimeRecording: "تسجيل التوقفات ", downtimeType: "نوع العطل ",
        selectDowntimeType: "اختر النوع... ", workerName: "اسم العامل ", workerNamePlaceholder: "أدخل اسم العامل... ",
        maintenance: "صيانة ", planningLoad: "تحميل من التخطيط ", materialIssue: "صرف خامات ",
        laborShortage: "عدم كفاية العمالة ", quality: "جودة ", description: "الوصف ",
        durationMinutes: "المدة (دقائق) ", recordDowntime: "تسجيل التوقف ", downtimeInfo: "معلومات التوقفات ",
        downtimeHelp: "سجل توقفات الماكينات للتحليل ", downtimeHelp2: "يستخدم في حسابات OEE ",
        downtimeStats: "إحصائيات التوقفات ", downtimeRecords: "سجلات التوقفات ",
        searchDowntime: "بحث في التوقفات... ", records: "سجل ",
        shortageReport: "تقرير النواقص ", shortageDesc: "عرض العناصر ذات الكمية المتبقية > 0 ",
        generateShortage: "إنشاء تقرير النواقص ", remainingQty: "الكمية المتبقية ",
        downtimeReport: "تقرير التوقفات ", generateDowntimeReport: "إنشاء تقرير التوقفات ",
        showingLatestDowntimeRecords: "عرض آخر 10 سجلات توقف. ",
        oeeTitle: "الفعالية الكلية للمعدات (OEE) ", oeeAvailability: "التوفر ",
        oeePerformance: "الأداء ", oeeQuality: "الجودة ", oeeValue: "OEE ",
        manageIdealRates: "تعيين السرعات المثالية للماكينات ", idealRate: "السرعة المثالية (قطعة/ساعة) ",
        rejectedQty: "الكمية المعيبة ", goodQty: "الكمية السليمة ", saveIdealRates: "حفظ السرعات المثالية ",
        ncrTitle: "عدم المطابقة ", ncrType: "نوع عدم المطابقة ", scrap: "خردة ",
        acceptAsIs: "قبول كما هو ", repair: "إصلاح ", ncrComment: "تعليق ",
        ncrCause: "سبب NCR ", recordNCR: "تسجيل NCR ", ncrRecords: "سجلات NCR ",
        searchNCR: "بحث في سجلات NCR... ", ncrDeleted: "تم حذف سجل NCR بنجاح ",
        areYouSureDeleteNCR: "هل أنت متأكد من حذف سجل NCR هذا؟ ",
        teepTitle: "الأداء الفعال الكلي للمعدات (TEEP) ", teepValue: "TEEP ",
        ncrReport: "تقرير NCR ", oeeReport: "تقرير OEE ", teepReport: "تقرير TEEP ",
        utilization: "الاستغلال ", totalProduction: "إجمالي الإنتاج ", totalRejected: "إجمالي الرفض ",
        hrTitle: "إدارة القوى العاملة (HR) ", employeeName: "اسم الموظف ",
        employeeId: "رقم الموظف ", department: "القسم ", position: "المنصب ", phone: "الهاتف ",
        hireDate: "تاريخ التوظيف ", status: "الحالة ", saveEmployee: "حفظ الموظف ", employeeList: "قائمة الموظفين ",
        totalEmployees: "إجمالي الموظفين ", activeEmployees: "نشط ", hrNotes: "ملاحظات الموارد البشرية ",
        employeeDeleted: "تم حذف الموظف بنجاح ",
        areYouSureDeleteEmployee: "هل أنت متأكد من حذف هذا الموظف؟ ",
        balanceComplete: "إكمال كـ Balance ", monthlyProductionReport: "تقرير الإنتاج الشهري ",
        monthlyReportDesc: "الإنتاج اليومي Minimum و Finish مقابل المستهدف (22 طن) ",
        month: "الشهر ", day: "اليوم ", date: "التاريخ ", target: "المستهدف (طن) ",
        actualMin: "Min (طن) ", actualFin: "Finish (طن) ", effMin: "كفاءة Min % ",
        effFin: "كفاءة Finish % ", cumEffMin: "كفاءة Min تراكمية % ", cumEffFin: "كفاءة Finish تراكمية % ",
        workingDay: "يوم عمل ", holiday: "إجازة ", generateMonthlyReport: "إنشاء التقرير الشهري ",
        logout: "تسجيل خروج", loginTitle: "تسجيل الدخول", username: "اسم المستخدم",
        password: "كلمة المرور", role: "الدور", loginButton: "دخول",
        loginHint: "للاختبار: استخدم أي اسم، واختر الدور المناسب",
        usernamePlaceholder: "أدخل اسم المستخدم", passwordPlaceholder: "أدخل كلمة المرور",
        rolePlanning: "التخطيط", roleProduction: "الإنتاج", roleQC: "الجودة",
        roleProjects: "المشروعات", roleTopManagement: "الإدارة العليا", roleAdministrator: "مدير النظام",
        markAsFinished: "إنهاء الأمر",
        markAsFinishedConfirm: "تأكيد إنهاء أمر العمل؟ (اكتمل ≥90%)",
        minCompletionRequired: "يلزم اكتمال 90% على الأقل لإنهاء الأمر",
        soFamilyTree: "شجرة عائلة أوامر البيع",
        soFamilyTreeDesc: "شجرة هرمية لكل Sales Order متفرع منها Work Orders ",
        treeSalesOrderFilter: "أمر البيع",
        treeStatusFilter: "الحالة",
        treeViewStyle: "نوع العرض",
        treeDetailView: "🌳 عرض شجري تفصيلي (قابل للطيّ)",
        treeSummaryView: "📋 عرض ملخّص (صف لكل أمر بيع)",
        treeDelayDays: "حدّ التأخير (أيام)",
        treeDelayBasis: "أساس احتساب التأخير",
        treeBasisAge: "الأيام منذ إنشاء أمر الشغل",
        treeBasisIdle: "الأيام منذ آخر نشاط إنتاجي",
        treeStatusAll: "الكل",
        treeStatusInProgress: "قيد التنفيذ فقط",
        treeStatusFinished: "المنتهية فقط",
        treeStatusDelayed: "المتأخرة فقط",
        generateFamilyTree: "إنشاء شجرة العائلة",
        noSalesOrdersMatch: "لا توجد أوامر بيع مطابقة",
        noWorkOrdersMatchFilter: "لا توجد أوامر عمل مطابقة"
    }
};

let currentLanguage = localStorage.getItem('appLanguage') || 'en';

function setLanguage(lang) {
    currentLanguage = lang;
    localStorage.setItem('appLanguage', lang);
    applyTranslations();
    applyLoginTranslations();
    updateRTL(lang);
    updateLanguageButtons();
    renderDashboard();
    renderEmployeesList();
}

function applyTranslations() {
    const t = translations[currentLanguage];
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (t[key]) {
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.placeholder = t[key];
            else el.textContent = t[key];
        }
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (t[key]) el.placeholder = t[key];
    });
}

function applyLoginTranslations() {
    const t = translations[currentLanguage];
    document.querySelectorAll('#loginScreen [data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (t[key]) {
            if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.placeholder = t[key];
            else el.textContent = t[key];
        }
    });
    document.querySelectorAll('#loginScreen [data-i18n-placeholder]').forEach(el => {
        const key = el.getAttribute('data-i18n-placeholder');
        if (t[key]) el.placeholder = t[key];
    });
    const btnEn = document.getElementById('loginBtnEn');
    const btnAr = document.getElementById('loginBtnAr');
    if (btnEn) btnEn.className = btnEn.className.replace('active', '').trim();
    if (btnAr) btnAr.className = btnAr.className.replace('active', '').trim();
    if (currentLanguage === 'en') {
        btnEn.classList.add('active', 'btn-primary');
        btnEn.classList.remove('btn-outline');
        btnAr.classList.remove('active', 'btn-primary');
        btnAr.classList.add('btn-outline');
    } else {
        btnAr.classList.add('active', 'btn-primary');
        btnAr.classList.remove('btn-outline');
        btnEn.classList.remove('active', 'btn-primary');
        btnEn.classList.add('btn-outline');
    }
}

function updateRTL(lang) {
    if (lang === 'ar') {
        document.documentElement.dir = 'rtl';
        document.body.classList.remove('ltr');
        document.body.classList.add('rtl');
    } else {
        document.documentElement.dir = 'ltr';
        document.body.classList.remove('rtl');
        document.body.classList.add('ltr');
    }
}

function updateLanguageButtons() {
    const btnEn = document.getElementById('btnEn');
    const btnAr = document.getElementById('btnAr');
    if (btnEn) btnEn.className = btnEn.className.replace('active', '').trim();
    if (btnAr) btnAr.className = btnAr.className.replace('active', '').trim();
    if (currentLanguage === 'en') {
        btnEn.classList.add('active', 'btn-primary');
        btnEn.classList.remove('btn-outline');
        btnAr.classList.remove('active', 'btn-primary');
        btnAr.classList.add('btn-outline');
    } else {
        btnAr.classList.add('active', 'btn-primary');
        btnAr.classList.remove('btn-outline');
        btnEn.classList.remove('active', 'btn-primary');
        btnEn.classList.add('btn-outline');
    }
}

// ============= isWorkOrderCompleted =============
function isWorkOrderCompleted(wo) {
    if (!wo || !wo.items || wo.items.length === 0) return false;
    return wo.items.every(item => {
        if (item.status === 'Completed') return true;
        if (!item.operations || item.operations.length === 0) return (item.completedQuantity || 0) >= item.quantity;
        return item.operations.every(op => {
            const comp = item.completedOperations ? item.completedOperations[op.name] : null;
            const qty = comp ? (parseInt(comp.completedQuantity) || 0) : 0;
            return qty >= item.quantity;
        });
    });
}

function getWorkOrderCompletionPercentage(wo) {
    let totalRequired = 0;
    let totalCompleted = 0;
    wo.items.forEach(item => {
        totalRequired += item.quantity;
        totalCompleted += (item.completedQuantity || 0);
    });
    if (totalRequired === 0) return 0;
    return (totalCompleted / totalRequired) * 100;
}

// ============= DASHBOARD =============
function renderDashboard() {
    document.getElementById('dashboardTimestamp').textContent = new Date().toLocaleString();
    const activeWorkOrders = workOrdersDB.filter(wo => !isWorkOrderCompleted(wo) && !wo.archived).length;
    const finishedWorkOrders = workOrdersDB.filter(wo => isWorkOrderCompleted(wo) || wo.archived).length;
    document.getElementById('dashboardActiveWO').textContent = activeWorkOrders;
    document.getElementById('dashboardFinishedWO').textContent = finishedWorkOrders;

    const yesterday = getYesterdayDateStr();
    const yesterdayProductionRecords = productionDB.filter(rec => rec.date === yesterday && getOperationPhase(rec.operation) === 'finish');
    const yesterdayProductionWeight = yesterdayProductionRecords.reduce((sum, rec) => sum + (rec.producedWeight || 0), 0);
    const yesterdayProductionTons = (yesterdayProductionWeight / 1000).toFixed(1);
    document.getElementById('dashboardProductionToday').textContent = `${yesterdayProductionTons} tons`;

    const yesterdayDowntime = downtimeDB.filter(rec => rec.date === yesterday).reduce((sum, rec) => sum + rec.durationMinutes, 0);
    const yesterdayDowntimeHours = (yesterdayDowntime / 60).toFixed(1);
    document.getElementById('dashboardDowntimeToday').textContent = `${yesterdayDowntimeHours} hrs`;

    let minTotalWeight = 0, minCompletedWeight = 0, finTotalWeight = 0, finCompletedWeight = 0;
    workOrdersDB.forEach(wo => {
        wo.items.forEach(item => {
            const w = item.weightPerPiece || 0;
            const totalW = item.quantity * w;
            item.operations.forEach(op => {
                const phase = getOperationPhase(op.name);
                const compQty = item.completedOperations[op.name] ? item.completedOperations[op.name].completedQuantity : 0;
                const compW = compQty * w;
                if (phase === 'minimum') { minTotalWeight += totalW; minCompletedWeight += Math.min(compW, totalW); }
                else if (phase === 'finish') { finTotalWeight += totalW; finCompletedWeight += Math.min(compW, totalW); }
            });
        });
    });
    const minTotalTons = minTotalWeight / 1000;
    const minCompletedTons = minCompletedWeight / 1000;
    const finTotalTons = finTotalWeight / 1000;
    const finCompletedTons = finCompletedWeight / 1000;
    const minPercent = minTotalWeight > 0 ? Math.round((minCompletedWeight / minTotalWeight) * 100) : 0;
    const finPercent = finTotalWeight > 0 ? Math.round((finCompletedWeight / finTotalWeight) * 100) : 0;
    document.getElementById('minimumTotalRequired').textContent = `${minTotalTons.toFixed(2)} ton`;
    document.getElementById('minimumCompleted').textContent = `${minCompletedTons.toFixed(2)} ton`;
    document.getElementById('minimumProgressPercent').textContent = `${minPercent}%`;
    document.getElementById('finishingTotalRequired').textContent = `${finTotalTons.toFixed(2)} ton`;
    document.getElementById('finishingCompleted').textContent = `${finCompletedTons.toFixed(2)} ton`;
    document.getElementById('finishingProgressPercent').textContent = `${finPercent}%`;
    const minDeg = (minPercent / 100) * 360;
    const finDeg = (finPercent / 100) * 360;
    document.getElementById('minimumProgressCircle').style.background = `conic-gradient(#1a237e ${minDeg}deg, #e5e7eb ${minDeg}deg)`;
    document.getElementById('finishingProgressCircle').style.background = `conic-gradient(#4caf50 ${finDeg}deg, #e5e7eb ${finDeg}deg)`;

    const downtimeMap = new Map();
    let totalDowntime = 0;
    downtimeDB.forEach(rec => {
        totalDowntime += rec.durationMinutes;
        downtimeMap.set(rec.downtimeType, (downtimeMap.get(rec.downtimeType) || 0) + rec.durationMinutes);
    });
    document.getElementById('totalDowntimeMinutes').textContent = `${totalDowntime} min`;
    const breakdown = document.getElementById('downtimeBreakdownContainer');
    breakdown.innerHTML = '';
    if (downtimeMap.size === 0) breakdown.innerHTML = '<p class="text-gray-500 text-center py-4">No downtime records</p>';
    else {
        const colors = ['#f44336', '#ff9800', '#2196f3', '#4caf50', '#9c27b0'];
        const typeLabels = { 'Machine': 'ماكينة', 'Material': 'خامة', 'Worker': 'عامل', 'Panel': 'لوحة' };
        let i = 0;
        for (let [type, mins] of downtimeMap.entries()) {
            const pct = totalDowntime > 0 ? (mins / totalDowntime) * 100 : 0;
            const label = typeLabels[type] || type;
            breakdown.innerHTML += `<div class="mb-2"><div class="flex justify-between text-sm mb-1"><span class="font-medium">${label}</span><span>${mins} min (${pct.toFixed(1)}%)</span></div><div class="downtime-breakdown-bar"><div class="downtime-breakdown-fill" style="width:${pct}%; background-color:${colors[i % colors.length]}"></div></div></div>`;
            i++;
        }
    }

    const recentBody = document.getElementById('recentDowntimeTableBody');
    recentBody.innerHTML = '';
    const recent = [...downtimeDB].sort((a, b) => b.timestamp - a.timestamp).slice(0, 5);
    if (recent.length === 0) recentBody.innerHTML = '<tr><td colspan="4" class="text-center py-4 text-gray-500">No downtime records</td></tr>';
    else {
        const typeLabels = { 'Machine': 'ماكينة', 'Material': 'خامة', 'Worker': 'عامل', 'Panel': 'لوحة' };
        recent.forEach(rec => {
            const label = typeLabels[rec.downtimeType] || rec.downtimeType;
            recentBody.innerHTML += `<tr><td class="text-center">${rec.date}</td><td class="text-center">${rec.machine}</td><td class="text-center">${label}</td><td class="text-center font-bold text-red-600">${rec.durationMinutes} min</td></tr>`;
        });
    }
    renderDashboardStageSummary();
    renderDashboardMonthlyReport();
}

// ====== Stage Summary ======
function computeStageSummary(scope) {
    const agg = {};
    const stages = ['minimum', 'crop', 'shear', 'bend', 'drill', 'chamfer', 'finish', 'general'];
    stages.forEach(s => { agg[s] = { totalQty: 0, doneQty: 0, totalWt: 0, doneWt: 0 }; });
    (scope || []).forEach(wo => {
        (wo.items || []).forEach(item => {
            const qty = parseInt(item.quantity) || 0;
            if (qty <= 0) return;
            const wpp = parseFloat(item.weightPerPiece) || (qty ? (parseFloat(item.totalWeight) || 0) / qty : 0);
            (item.operations || []).forEach(op => {
                const phase = getOperationPhase(op.name);
                const bucket = agg[phase] || agg.general;
                const comp = item.completedOperations ? item.completedOperations[op.name] : null;
                let done = comp ? (parseInt(comp.completedQuantity) || 0) : 0;
                if (done > qty) done = qty;
                if (done < 0) done = 0;
                bucket.totalQty += qty; bucket.doneQty += done;
                bucket.totalWt += qty * wpp; bucket.doneWt += done * wpp;
            });
        });
    });
    return agg;
}

function buildStageSummaryHeaderHTML() {
    return `<tr><th>#</th><th>Stage</th><th>Total Qty</th><th>Completed</th><th>In Progress</th><th>Completion %</th><th>Total Weight (ton)</th><th>Completed Weight (ton)</th><th>Remaining Weight (ton)</th></tr>`;
}

function buildStageSummaryRowsHTML(agg) {
    let gTotQty = 0, gDoneQty = 0, gTotWt = 0, gDoneWt = 0;
    const rows = [];
    let idx = 0;
    const stages = ['minimum', 'crop', 'shear', 'bend', 'drill', 'chamfer', 'finish', 'general'];
    const labels = { minimum: 'Minimum', crop: 'Cropping', shear: 'Shearing', bend: 'Bending', drill: 'Drilling', chamfer: 'Chamfering', finish: 'Finishing', general: 'Other Operations' };
    stages.forEach(s => {
        const b = agg[s];
        if (b.totalQty === 0) return;
        idx++;
        const remQty = b.totalQty - b.doneQty;
        const remWt = b.totalWt - b.doneWt;
        const pct = b.totalWt > 0 ? (b.doneWt / b.totalWt * 100) : 0;
        gTotQty += b.totalQty; gDoneQty += b.doneQty; gTotWt += b.totalWt; gDoneWt += b.doneWt;
        let pctClass = 'bg-red-100 text-red-800';
        if (pct >= 100) pctClass = 'bg-green-100 text-green-800';
        else if (pct >= 50) pctClass = 'bg-yellow-100 text-yellow-800';
        else if (pct > 0) pctClass = 'bg-orange-100 text-orange-800';
        const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
        const fmtTon = (kg) => Math.round((Number(kg) || 0) / 1000).toLocaleString('en-US');
        rows.push(`<tr><td class="text-center">${idx}</td><td class="font-bold">${labels[s] || s}</td><td class="text-center">${fmtInt(b.totalQty)}</td><td class="text-center text-green-700 font-semibold">${fmtInt(b.doneQty)}</td><td class="text-center text-orange-700 font-semibold">${fmtInt(remQty)}</td><td class="text-center"><span class="status-indicator ${pctClass}">${pct.toFixed(1)}%</span></td><td class="text-center">${fmtTon(b.totalWt)}</td><td class="text-center">${fmtTon(b.doneWt)}</td><td class="text-center">${fmtTon(remWt)}</td></tr>`);
    });
    if (rows.length === 0) return '<tr><td colspan="9" class="text-center py-4">No data available</td></tr>';
    const gRemQty = gTotQty - gDoneQty;
    const gRemWt = gTotWt - gDoneWt;
    const gPct = gTotWt > 0 ? (gDoneWt / gTotWt * 100) : 0;
    const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
    const fmtTon = (kg) => Math.round((Number(kg) || 0) / 1000).toLocaleString('en-US');
    rows.push(`<tr class="total-row" style="background:#fef3c7;font-weight:700;"><td class="text-center"></td><td class="font-bold">TOTAL (All Stages)</td><td class="text-center font-bold">${fmtInt(gTotQty)}</td><td class="text-center font-bold">${fmtInt(gDoneQty)}</td><td class="text-center font-bold">${fmtInt(gRemQty)}</td><td class="text-center font-bold">${gPct.toFixed(1)}%</td><td class="text-center font-bold">${fmtTon(gTotWt)}</td><td class="text-center font-bold">${fmtTon(gDoneWt)}</td><td class="text-center font-bold">${fmtTon(gRemWt)}</td></tr>`);
    return rows.join('');
}

function renderStageSummaryInto(headEl, bodyEl, salesOrderFilter) {
    const scope = workOrdersDB.filter(wo => (!salesOrderFilter || wo.salesOrderNumber === salesOrderFilter));
    const agg = computeStageSummary(scope);
    headEl.innerHTML = buildStageSummaryHeaderHTML();
    bodyEl.innerHTML = buildStageSummaryRowsHTML(agg);
}

function getDistinctSalesOrders() {
    return [...new Set(workOrdersDB.map(wo => wo.salesOrderNumber).filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
}

function populateDashboardStageSummarySO() {
    const sel = document.getElementById('dashboardStageSummarySO');
    if (!sel) return;
    const prev = sel.value;
    const sos = getDistinctSalesOrders();
    sel.innerHTML = '<option value="">All Sales Orders</option>';
    sos.forEach(so => { sel.innerHTML += `<option value="${esc(so)}">${esc(so)}</option>`; });
    if (prev && sos.includes(prev)) sel.value = prev;
}

function renderDashboardStageSummary() {
    const head = document.getElementById('dashboardStageSummaryHead');
    const body = document.getElementById('dashboardStageSummaryBody');
    if (!head || !body) return;
    populateDashboardStageSummarySO();
    const sel = document.getElementById('dashboardStageSummarySO');
    renderStageSummaryInto(head, body, sel ? sel.value : '');
}

function refreshDashboardStageSummaryTable() {
    const head = document.getElementById('dashboardStageSummaryHead');
    const body = document.getElementById('dashboardStageSummaryBody');
    if (!head || !body) return;
    const sel = document.getElementById('dashboardStageSummarySO');
    renderStageSummaryInto(head, body, sel ? sel.value : '');
}

function openStageSummaryFullReport() {
    const dsel = document.getElementById('dashboardStageSummarySO');
    const so = dsel ? dsel.value : '';
    switchTab('reports');
    selectReportType('projectStageSummary');
    const rsel = document.getElementById('stageSummarySO');
    if (rsel) { rsel.value = so; generateProjectStageSummary(); }
}

// ====== MONTHLY PRODUCTION REPORT ======
function computeMonthlyReportData(year, month) {
    const now = new Date();
    const isCurrentMonth = (now.getFullYear() === year && now.getMonth() === month - 1);
    const lastDay = new Date(year, month, 0);
    const daysInMonth = lastDay.getDate();
    let endDay = daysInMonth;
    if (isCurrentMonth) endDay = now.getDate() - 1;
    if (endDay < 1) return [];

    const days = [];
    for (let d = 1; d <= endDay; d++) {
        const dateObj = new Date(year, month - 1, d);
        const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        days.push({ dateStr, dateObj });
    }
    const targetTons = 22;
    const prodByDate = new Map();
    productionDB.forEach(rec => {
        if (!rec.date) return;
        const [y, m, d] = rec.date.split('-').map(Number);
        if (y !== year || m !== month) return;
        const phase = getOperationPhase(rec.operation);
        if (phase !== 'minimum' && phase !== 'finish') return;
        const wt = parseFloat(rec.producedWeight) || 0;
        if (!prodByDate.has(rec.date)) prodByDate.set(rec.date, { min: 0, fin: 0 });
        const entry = prodByDate.get(rec.date);
        if (phase === 'minimum') entry.min += wt;
        else if (phase === 'finish') entry.fin += wt;
    });

    const reportData = [];
    let cumMin = 0, cumFin = 0;
    let cumulativeTarget = 0;
    let workingDays = 0;

    for (const day of days) {
        const dateStr = day.dateStr;
        const dateObj = day.dateObj;
        const dayOfWeek = dateObj.getDay();
        const isFriday = (dayOfWeek === 5);
        const prod = prodByDate.get(dateStr) || { min: 0, fin: 0 };
        const minTons = prod.min / 1000;
        const finTons = prod.fin / 1000;
        const isHoliday = isFriday || (minTons === 0 && finTons === 0);
        let effMin = 0, effFin = 0;
        if (!isHoliday) {
            workingDays++;
            cumulativeTarget += targetTons;
            effMin = targetTons > 0 ? (minTons / targetTons) * 100 : 0;
            effFin = targetTons > 0 ? (finTons / targetTons) * 100 : 0;
            cumMin += minTons; cumFin += finTons;
        }
        const cumEffMin = cumulativeTarget > 0 ? (cumMin / cumulativeTarget) * 100 : 0;
        const cumEffFin = cumulativeTarget > 0 ? (cumFin / cumulativeTarget) * 100 : 0;
        let statusText = '';
        if (isHoliday) {
            const baseHoliday = translations[currentLanguage].holiday || 'Holiday';
            if (isFriday) statusText = currentLanguage === 'ar' ? `${baseHoliday} (جمعة)` : `${baseHoliday} (Friday)`;
            else statusText = currentLanguage === 'ar' ? `${baseHoliday} (لا يوجد إنتاج)` : `${baseHoliday} (No Production)`;
        } else statusText = translations[currentLanguage].workingDay || 'Working';
        const statusClass = isHoliday ? 'badge-warning' : 'badge-success';
        reportData.push({ date: dateStr, dateObj, dayOfWeek, isHoliday, isFriday, minTons, finTons, effMin, effFin, cumEffMin, cumEffFin, statusText, statusClass, workingDays, cumMin, cumFin, cumulativeTarget });
    }
    return reportData;
}

async function generateMonthlyProductionReport() {
    const monthInput = document.getElementById('monthlyReportMonth');
    if (!monthInput || !monthInput.value) { showToast('Month not selected', 'warning'); return; }
    const [year, month] = monthInput.value.split('-').map(Number);
    const reportData = computeMonthlyReportData(year, month);
    const monthLabel = new Date(year, month - 1).toLocaleString(currentLanguage, { month: 'long', year: 'numeric' });
    document.getElementById('reportTitle').textContent = `Monthly Production Report - ${monthLabel}`;
    const header = document.getElementById('reportTableHeader');
    const body = document.getElementById('reportTableBody');
    header.innerHTML = `<tr><th>#</th><th>Date</th><th>Day</th><th>Min (tons)</th><th>Finish (tons)</th><th>Target (tons)</th><th>Min Eff %</th><th>Finish Eff %</th><th>Cum. Min Eff %</th><th>Cum. Finish Eff %</th><th>Status</th></tr>`;
    if (reportData.length === 0) {
        body.innerHTML = `<tr><td colspan="11" class="text-center py-4">${translations[currentLanguage].noData || 'No production data'}</td></tr>`;
    } else {
        const rows = [];
        reportData.forEach((row, idx) => {
            const dayName = row.dateObj.toLocaleDateString(currentLanguage, { weekday: 'long' });
            rows.push(`<tr><td class="text-center">${idx + 1}</td><td class="text-center">${row.date}</td><td class="text-center">${dayName}</td><td class="text-center">${row.minTons.toFixed(2)}</td><td class="text-center">${row.finTons.toFixed(2)}</td><td class="text-center">${22}</td><td class="text-center">${row.effMin.toFixed(1)}%</td><td class="text-center">${row.effFin.toFixed(1)}%</td><td class="text-center font-bold">${row.cumEffMin.toFixed(1)}%</td><td class="text-center font-bold">${row.cumEffFin.toFixed(1)}%</td><td class="text-center"><span class="badge ${row.statusClass}">${row.statusText}</span></td></tr>`);
        });
        const totalWorkingDays = reportData.filter(r => !r.isHoliday).length;
        const totalCumMin = reportData.reduce((sum, r) => sum + r.minTons, 0);
        const totalCumFin = reportData.reduce((sum, r) => sum + r.finTons, 0);
        const totalCumTarget = totalWorkingDays * 22;
        const overallMinEff = totalCumTarget > 0 ? (totalCumMin / totalCumTarget) * 100 : 0;
        const overallFinEff = totalCumTarget > 0 ? (totalCumFin / totalCumTarget) * 100 : 0;
        rows.push(`<tr class="total-row" style="background:#fef3c7;font-weight:700;"><td class="text-center"></td><td class="text-center font-bold" colspan="2">TOTAL / AVERAGE</td><td class="text-center font-bold">${totalCumMin.toFixed(2)}</td><td class="text-center font-bold">${totalCumFin.toFixed(2)}</td><td class="text-center"></td><td class="text-center font-bold">${overallMinEff.toFixed(1)}%</td><td class="text-center font-bold">${overallFinEff.toFixed(1)}%</td><td class="text-center font-bold" colspan="2"></td><td class="text-center">Working Days: ${totalWorkingDays}</td></tr>`);
        body.innerHTML = rows.join('');
    }
    document.getElementById('reportResults').classList.remove('hidden');
    document.getElementById('reportResults').scrollIntoView({ behavior: 'smooth' });
    showToast('Monthly report generated', 'success');
}

function renderDashboardMonthlyReport() {
    const head = document.getElementById('dashboardMonthlyReportHead');
    const body = document.getElementById('dashboardMonthlyReportBody');
    if (!head || !body) return;
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    const reportData = computeMonthlyReportData(year, month);
    const monthLabel = new Date(year, month - 1).toLocaleString(currentLanguage, { month: 'long', year: 'numeric' });
    const monthSpan = document.getElementById('dashboardMonthlyReportMonth');
    if (monthSpan) monthSpan.textContent = monthLabel;
    head.innerHTML = `<tr><th>#</th><th>Date</th><th>Day</th><th>Min (tons)</th><th>Finish (tons)</th><th>Target (tons)</th><th>Min Eff %</th><th>Finish Eff %</th><th>Cum. Min Eff %</th><th>Cum. Finish Eff %</th><th>Status</th></tr>`;
    if (reportData.length === 0) {
        body.innerHTML = `<tr><td colspan="11" class="text-center py-4">${translations[currentLanguage].noData || 'No production data'}</td></tr>`;
    } else {
        const rows = [];
        reportData.forEach((row, idx) => {
            const dayName = row.dateObj.toLocaleDateString(currentLanguage, { weekday: 'long' });
            rows.push(`<tr><td class="text-center">${idx + 1}</td><td class="text-center">${row.date}</td><td class="text-center">${dayName}</td><td class="text-center">${row.minTons.toFixed(2)}</td><td class="text-center">${row.finTons.toFixed(2)}</td><td class="text-center">${22}</td><td class="text-center">${row.effMin.toFixed(1)}%</td><td class="text-center">${row.effFin.toFixed(1)}%</td><td class="text-center font-bold">${row.cumEffMin.toFixed(1)}%</td><td class="text-center font-bold">${row.cumEffFin.toFixed(1)}%</td><td class="text-center"><span class="badge ${row.statusClass}">${row.statusText}</span></td></tr>`);
        });
        const totalWorkingDays = reportData.filter(r => !r.isHoliday).length;
        const totalCumMin = reportData.reduce((sum, r) => sum + r.minTons, 0);
        const totalCumFin = reportData.reduce((sum, r) => sum + r.finTons, 0);
        const totalCumTarget = totalWorkingDays * 22;
        const overallMinEff = totalCumTarget > 0 ? (totalCumMin / totalCumTarget) * 100 : 0;
        const overallFinEff = totalCumTarget > 0 ? (totalCumFin / totalCumTarget) * 100 : 0;
        rows.push(`<tr class="total-row" style="background:#fef3c7;font-weight:700;"><td class="text-center"></td><td class="text-center font-bold" colspan="2">TOTAL / AVERAGE</td><td class="text-center font-bold">${totalCumMin.toFixed(2)}</td><td class="text-center font-bold">${totalCumFin.toFixed(2)}</td><td class="text-center"></td><td class="text-center font-bold">${overallMinEff.toFixed(1)}%</td><td class="text-center font-bold">${overallFinEff.toFixed(1)}%</td><td class="text-center font-bold" colspan="2"></td><td class="text-center">Working Days: ${totalWorkingDays}</td></tr>`);
        body.innerHTML = rows.join('');
    }
}

// ============================================================================
// ✅ SALES ORDER FAMILY TREE v2.3.0 — شجرة عائلة أوامر البيع
// ============================================================================
const SO_TREE_SETTINGS_KEY = 'soTreeDelaySettings';
const SO_TREE_DAY_MS = 86400000;
let soTreeState = {
    expanded: new Set(), lastNames: [],
    soFilter: '', statusFilter: 'all', viewStyle: 'detail',
    delayDays: 30, basis: 'age',
    search: '', sort: 'so', searchTimer: null
};

function soTreeT(key, fallback) {
    const t = (typeof translations !== 'undefined' && translations[currentLanguage]) ? translations[currentLanguage] : {};
    return (t[key] || fallback || '').toString().trim();
}

function soTreeLoadSettings() {
    try {
        const s = JSON.parse(localStorage.getItem(SO_TREE_SETTINGS_KEY) || 'null');
        if (s && Number(s.days) > 0) return { days: Math.round(Number(s.days)), basis: s.basis === 'idle' ? 'idle' : 'age' };
    } catch (e) { }
    return { days: 30, basis: 'age' };
}
function soTreeSaveSettings(days, basis) {
    try { localStorage.setItem(SO_TREE_SETTINGS_KEY, JSON.stringify({ days, basis })); } catch (e) { }
}

function soTreeDaysSince(ms) {
    if (!ms || isNaN(ms)) return null;
    return Math.max(0, Math.floor((Date.now() - ms) / SO_TREE_DAY_MS));
}
function soTreeParseDate(str) {
    if (typeof str === 'string' && /^\d{4}-\d{2}-\d{2}/.test(str)) {
        const d = new Date(str.slice(0, 10) + 'T00:00:00');
        return isNaN(d.getTime()) ? null : d.getTime();
    }
    return null;
}
function soTreeFmtDate(ms) { return ms ? getLocalDateStr(new Date(ms)) : ''; }

function soTreeBuildLastActivityMap() {
    const m = new Map();
    (productionDB || []).forEach(r => {
        if (r.workOrderId === undefined || r.workOrderId === null) return;
        const t = soTreeParseDate(r.date) || r.timestamp || 0;
        if (!t) return;
        const k = String(r.workOrderId);
        if (!m.has(k) || t > m.get(k)) m.set(k, t);
    });
    return m;
}

function soTreeDelayInfo(wo, isActive, lastAct, days, basis) {
    const created = wo.timestamp || soTreeParseDate(wo.date) || null;
    const ageDays = soTreeDaysSince(created);
    const lastTs = lastAct.get(String(wo.id));
    const idleDays = lastTs ? soTreeDaysSince(lastTs) : ageDays;
    const metric = basis === 'idle' ? idleDays : ageDays;
    let level = 'ok';
    if (isActive && metric !== null) {
        if (metric > days * 2) level = 'critical';
        else if (metric > days) level = 'delayed';
    }
    return { created, ageDays, idleDays, metric, level };
}

function soTreeCollectBuckets() {
    const st = soTreeState;
    const q = (st.search || '').trim().toLowerCase();
    const lastAct = soTreeBuildLastActivityMap();
    const soMap = new Map();

    workOrdersDB.forEach(wo => {
        const so = wo.salesOrderNumber || 'N/A';
        if (st.soFilter && so !== st.soFilter) return;
        const items = wo.items || [];
        const isFinished = isWorkOrderCompleted(wo);
        const isArchived = wo.archived === true;
        const isActive = !isFinished && !isArchived;

        let woTotalWt = 0, woDoneWt = 0, doneItems = 0;
        items.forEach(item => {
            if (item.status === 'Completed') doneItems++;
            const wpp = item.weightPerPiece || 0;
            const qty = item.quantity || 0;
            woTotalWt += qty * wpp;
            woDoneWt += Math.min(item.completedQuantity || 0, qty) * wpp;
        });
        let pct = woTotalWt > 0 ? (woDoneWt / woTotalWt) * 100 : getWorkOrderCompletionPercentage(wo);
        pct = Math.max(0, Math.min(100, pct || 0));

        const delay = soTreeDelayInfo(wo, isActive, lastAct, st.delayDays, st.basis);
        const entry = { wo, isFinished, isArchived, isActive, pct, woTotalWt, woDoneWt, doneItems, totalItems: items.length, delay };

        const f = st.statusFilter;
        const include = f === 'all'
            || (f === 'inprogress' && isActive)
            || (f === 'finished' && (isFinished || isArchived))
            || (f === 'delayed' && isActive && delay.level !== 'ok');
        if (!include) return;

        if (q) {
            const hay = [so, wo.projectName, wo.workOrderName, wo.type, wo.model].join(' ').toLowerCase();
            if (!hay.includes(q)) return;
        }

        if (!soMap.has(so)) soMap.set(so, { salesOrder: so, projects: new Set(), workOrders: [] });
        const b = soMap.get(so);
        if (wo.projectName) b.projects.add(wo.projectName);
        b.workOrders.push(entry);
    });

    const buckets = [...soMap.values()];
    buckets.forEach(b => {
        b.workOrders.sort((a, c) => (c.wo.timestamp || 0) - (a.wo.timestamp || 0));
        b.totalWOs = b.workOrders.length;
        b.finishedWOs = b.workOrders.filter(e => e.isFinished || e.isArchived).length;
        b.archivedWOs = b.workOrders.filter(e => e.isArchived).length;
        b.activeWOs = b.workOrders.filter(e => e.isActive).length;
        b.delayedWOs = b.workOrders.filter(e => e.isActive && e.delay.level === 'delayed').length;
        b.criticalWOs = b.workOrders.filter(e => e.isActive && e.delay.level === 'critical').length;
        b.totalItems = b.workOrders.reduce((s, e) => s + e.totalItems, 0);
        b.completedItems = b.workOrders.reduce((s, e) => s + e.doneItems, 0);
        b.totalWeight = b.workOrders.reduce((s, e) => s + e.woTotalWt, 0);
        b.completedWeight = b.workOrders.reduce((s, e) => s + e.woDoneWt, 0);
        b.pct = b.totalWeight > 0 ? (b.completedWeight / b.totalWeight * 100) : 0;
        const metrics = b.workOrders.filter(e => e.isActive && e.delay.metric !== null).map(e => e.delay.metric);
        b.maxMetric = metrics.length ? Math.max(...metrics) : null;
        b.level = b.criticalWOs > 0 ? 'critical' : (b.delayedWOs > 0 ? 'delayed' : 'ok');
        b.status = b.activeWOs === 0
            ? (b.archivedWOs > 0 ? 'Finished (Archived)' : 'Completed')
            : (b.pct > 0 ? 'In Progress' : 'Not Started');
    });
    return soTreeSortBuckets(buckets, st.sort);
}

function soTreeSortBuckets(buckets, sort) {
    const byName = (a, b) => String(a.salesOrder).localeCompare(String(b.salesOrder), undefined, { numeric: true });
    const rank = { critical: 2, delayed: 1, ok: 0 };
    const arr = [...buckets];
    if (sort === 'delayFirst') {
        arr.sort((a, b) => (rank[b.level] - rank[a.level]) || ((b.maxMetric || 0) - (a.maxMetric || 0)) || byName(a, b));
    } else if (sort === 'progressAsc') {
        arr.sort((a, b) => ((a.activeWOs === 0) - (b.activeWOs === 0)) || (a.pct - b.pct) || byName(a, b));
    } else if (sort === 'weightDesc') {
        arr.sort((a, b) => (b.totalWeight - a.totalWeight) || byName(a, b));
    } else {
        arr.sort(byName);
    }
    return arr;
}

const soTreeFmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
const soTreeFmtTon = (kg) => ((Number(kg) || 0) / 1000).toFixed(2);

function soTreePctColor(p) {
    if (p >= 100) return '#059669';
    if (p >= 50) return '#d97706';
    if (p > 0) return '#ea580c';
    return '#dc2626';
}
function soTreeProgressCell(pct) {
    const c = soTreePctColor(pct);
    return `<div class="so-pbar"><div class="so-pbar-fill" style="width:${pct.toFixed(1)}%;background:${c};"></div></div><span style="font-weight:700;color:${c};">${pct.toFixed(1)}%</span>`;
}
function soTreeStatusBadge(text) {
    let cls = 'so-badge-neutral';
    if (text === 'Completed' || text === 'Finished') cls = 'so-badge-ok';
    else if (text === 'Finished (Archived)' || text === 'Archived') cls = 'so-badge-archived';
    else if (text === 'In Progress') cls = 'so-badge-progress';
    else if (text === 'Not Started') cls = 'so-badge-notstarted';
    return `<span class="so-badge ${cls}">${text}</span>`;
}
function soTreeStackBar(b) {
    if (!b.totalWOs) return '';
    const seg = (n, c, label) => n > 0 ? `<div title="${label}: ${n}" style="width:${(n / b.totalWOs * 100).toFixed(2)}%;background:${c};"></div>` : '';
    const onTrack = b.activeWOs - b.delayedWOs - b.criticalWOs;
    const finishedOnly = b.finishedWOs - b.archivedWOs;
    return `<div class="so-stack">${seg(finishedOnly, '#059669', 'Finished')}${seg(b.archivedWOs, '#7c3aed', 'Archived')}${seg(onTrack, '#f59e0b', 'In progress')}${seg(b.delayedWOs, '#ea580c', 'Delayed')}${seg(b.criticalWOs, '#dc2626', 'Critical')}</div>`;
}
function soTreeMetricLabel() { return soTreeState.basis === 'idle' ? 'Idle (days)' : 'Age (days)'; }
function soTreeMetricCell(metric, level, active) {
    if (!active || metric === null || metric === undefined) return '-';
    const color = level === 'critical' ? '#dc2626' : (level === 'delayed' ? '#d97706' : '#334155');
    return `<span style="font-weight:700;color:${color};">${metric}</span>`;
}
function soTreeWoAlertHtml(e) {
    if (!e.isActive) return '<span class="so-badge so-badge-neutral">-</span>';
    const d = e.delay;
    if (d.metric === null) return '<span class="so-badge so-badge-neutral">N/A</span>';
    if (d.level === 'critical') return `<span class="so-badge so-badge-critical"><i class="fa-solid fa-triangle-exclamation"></i> Critical ${d.metric}d</span>`;
    if (d.level === 'delayed') return `<span class="so-badge so-badge-delayed"><i class="fa-solid fa-clock"></i> Delayed ${d.metric}d</span>`;
    return '<span class="so-badge so-badge-ok">On track</span>';
}
function soTreeSoAlertHtml(b) {
    if (b.activeWOs === 0) return '<span class="so-badge so-badge-neutral">-</span>';
    if (b.level === 'critical') {
        const extra = b.delayedWOs > 0 ? ` / ${b.delayedWOs} delayed` : '';
        return `<span class="so-badge so-badge-critical"><i class="fa-solid fa-triangle-exclamation"></i> ${b.criticalWOs} critical${extra}</span>`;
    }
    if (b.level === 'delayed') return `<span class="so-badge so-badge-delayed"><i class="fa-solid fa-clock"></i> ${b.delayedWOs} delayed</span>`;
    return '<span class="so-badge so-badge-ok">On track</span>';
}

function soTreeKpiHtml(buckets) {
    const st = soTreeState;
    const sum = (k) => buckets.reduce((s, b) => s + b[k], 0);
    const totalWOs = sum('totalWOs'), finished = sum('finishedWOs'), active = sum('activeWOs');
    const delayed = sum('delayedWOs'), critical = sum('criticalWOs');
    const totalWt = sum('totalWeight'), doneWt = sum('completedWeight');
    const overall = totalWt > 0 ? (doneWt / totalWt * 100) : 0;
    const lateTotal = delayed + critical;
    const card = (bg, label, value, sub, extra) => `
        <div ${extra || ''} style="background:${bg};color:#fff;padding:0.85rem 1rem;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.1);">
            <div style="font-size:0.7rem;opacity:0.85;text-transform:uppercase;letter-spacing:0.5px;">${label}</div>
            <div style="font-size:1.7rem;font-weight:800;line-height:1.2;">${value}</div>
            <div style="font-size:0.7rem;opacity:0.85;min-height:1em;">${sub || ''}</div>
        </div>`;
    const basisTxt = st.basis === 'idle' ? 'no production activity' : 'since creation';
    return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:0.7rem;margin-bottom:0.9rem;">
        ${card('linear-gradient(135deg,#0369a1,#075985)', 'Sales Orders', buckets.length, '')}
        ${card('linear-gradient(135deg,#059669,#047857)', 'Finished WOs', `${finished}<span style="font-size:0.85rem;opacity:0.8;"> / ${totalWOs}</span>`, '')}
        ${card('linear-gradient(135deg,#d97706,#b45309)', 'Active WOs', active, '')}
        ${card(lateTotal > 0 ? 'linear-gradient(135deg,#dc2626,#991b1b)' : 'linear-gradient(135deg,#64748b,#475569)', 'Delay Alerts', lateTotal, lateTotal > 0 ? `${critical} critical • ${delayed} delayed (click to filter)` : 'No delayed work orders', lateTotal > 0 ? 'onclick="soTreeFilterDelayed()" style="cursor:pointer;"' : '')}
        ${card('linear-gradient(135deg,#7c3aed,#6d28d9)', 'Overall Progress', overall.toFixed(1) + '%', 'by weight')}
        ${card('linear-gradient(135deg,#0f766e,#115e59)', 'Weight (ton)', `<span style="font-size:1.3rem;">${soTreeFmtTon(doneWt)} / ${soTreeFmtTon(totalWt)}</span>`, '')}
    </div>
    <div style="font-size:0.72rem;color:#64748b;margin-bottom:0.6rem;">
        <i class="fa-solid fa-circle-info"></i> Delay rule: an active work order is <strong style="color:#d97706;">Delayed</strong> after more than ${st.delayDays} day(s) ${basisTxt}, and <strong style="color:#dc2626;">Critical</strong> after more than ${st.delayDays * 2} days.
    </div>`;
}

function soTreeToolbarHtml() {
    const st = soTreeState;
    const opt = (v, t, cur) => `<option value="${v}"${v === cur ? ' selected' : ''}>${t}</option>`;
    const isDetail = st.viewStyle !== 'summary';
    return `<div class="no-print" style="display:flex;flex-wrap:wrap;gap:0.6rem;align-items:center;margin-bottom:0.8rem;">
        <input id="soTreeSearch" type="text" class="input-field" style="max-width:260px;" placeholder="Search SO / project / work order..." value="${esc(st.search)}" oninput="soTreeSetSearch(this.value)">
        <select id="soTreeSort" class="input-field" style="max-width:230px;" onchange="soTreeSetSort(this.value)">
            ${opt('so', 'Sort: Sales Order No.', st.sort)}
            ${opt('delayFirst', 'Sort: Most delayed first', st.sort)}
            ${opt('progressAsc', 'Sort: Lowest progress first', st.sort)}
            ${opt('weightDesc', 'Sort: Heaviest first', st.sort)}
        </select>
        ${isDetail ? `
        <button type="button" class="btn btn-sm" style="border:1px solid #cbd5e1;background:#fff;color:#1e3a8a;" onclick="soTreeExpandAll(true)"><i class="fa-solid fa-angles-down"></i> Expand all</button>
        <button type="button" class="btn btn-sm" style="border:1px solid #cbd5e1;background:#fff;color:#1e3a8a;" onclick="soTreeExpandAll(false)"><i class="fa-solid fa-angles-up"></i> Collapse all</button>` : ''}
        <span style="font-size:0.72rem;color:#64748b;display:flex;gap:0.8rem;flex-wrap:wrap;">
            <span><span class="so-dot" style="background:#059669;"></span>Finished</span>
            <span><span class="so-dot" style="background:#7c3aed;"></span>Archived</span>
            <span><span class="so-dot" style="background:#f59e0b;"></span>In progress</span>
            <span><span class="so-dot" style="background:#ea580c;"></span>Delayed</span>
            <span><span class="so-dot" style="background:#dc2626;"></span>Critical</span>
        </span>
    </div>`;
}

function generateSalesOrderTree() {
    if (!hasPermission('canViewReports')) { showToast('غير مسموح لك بعرض التقارير', 'error'); return; }
    const st = soTreeState;
    const saved = soTreeLoadSettings();

    st.soFilter = document.getElementById('treeSalesOrderFilter')?.value || '';
    st.statusFilter = document.getElementById('treeStatusFilter')?.value || 'all';
    st.viewStyle = document.getElementById('treeViewStyle')?.value === 'summary' ? 'summary' : 'detail';
    const daysInput = parseInt(document.getElementById('treeDelayDays')?.value, 10);
    st.delayDays = daysInput > 0 ? daysInput : saved.days;
    st.basis = (document.getElementById('treeDelayBasis')?.value || saved.basis) === 'idle' ? 'idle' : 'age';
    soTreeSaveSettings(st.delayDays, st.basis);

    const preview = soTreeCollectBuckets();
    const expandAll = !!st.soFilter || st.statusFilter === 'delayed' || preview.length <= 3;
    st.expanded = new Set(expandAll ? preview.map(b => b.salesOrder) : []);

    document.getElementById('reportTitle').textContent = 'Sales Order Family Tree' + (st.soFilter ? ` - ${st.soFilter}` : '');
    const strip = document.getElementById('reportSummaryStrip');
    if (strip) strip.innerHTML = '<div id="soTreeKpis"></div>' + soTreeToolbarHtml();

    soTreeRefresh();
    document.getElementById('reportResults').classList.remove('hidden');
    document.getElementById('reportResults').scrollIntoView({ behavior: 'smooth' });
    showToast('Sales Order family tree generated', 'success');
}

function soTreeRefresh() {
    const st = soTreeState;
    const buckets = soTreeCollectBuckets();
    st.lastNames = buckets.map(b => b.salesOrder);

    const kpis = document.getElementById('soTreeKpis');
    if (kpis) kpis.innerHTML = soTreeKpiHtml(buckets);

    const header = document.getElementById('reportTableHeader');
    const body = document.getElementById('reportTableBody');

    if (buckets.length === 0) {
        header.innerHTML = '';
        body.innerHTML = `<tr><td class="text-center py-8 text-gray-500">${soTreeT('noSalesOrdersMatch', 'No Sales Orders match the current filter')}</td></tr>`;
        return;
    }
    if (st.viewStyle === 'summary') soTreeRenderSummary(buckets, header, body);
    else soTreeRenderDetail(buckets, header, body);
}

function soTreeRenderDetail(buckets, header, body) {
    const st = soTreeState;
    const searching = !!(st.search || '').trim();
    header.innerHTML = `<tr>
        <th style="width:24%">Sales Order → Work Order</th>
        <th>Project</th><th>Type / Model</th><th>Created</th>
        <th>${soTreeMetricLabel()}</th><th>Items</th><th style="min-width:110px">Progress %</th>
        <th>Done Weight (ton)</th><th>Total Weight (ton)</th><th>Status</th><th>Delay Alert</th>
    </tr>`;

    let html = '';
    buckets.forEach(b => {
        const open = searching || st.expanded.has(b.salesOrder);
        html += `<tr class="so-row${open ? ' open' : ''}" data-so="${esc(b.salesOrder)}" onclick="soTreeToggle(this.dataset.so)" title="Click to expand / collapse">
            <td style="text-align:left;">
                <div style="display:flex;align-items:center;gap:0.5rem;">
                    <i class="fa-solid fa-chevron-right so-chev"></i>
                    <i class="fa-solid fa-folder-open text-blue-700"></i>
                    <div style="flex:1;min-width:150px;">
                        <div style="font-weight:800;color:#0c4a6e;font-size:0.95rem;">${esc(b.salesOrder)}</div>
                        <div style="font-size:0.7rem;color:#0369a1;"> ${b.totalWOs} work order(s) • ${b.finishedWOs} finished</div>
                        ${soTreeStackBar(b)}
                    </div>
                </div>
            </td>
            <td class="text-center" style="font-size:0.78rem;">${[...b.projects].map(esc).join(' • ')}</td>
            <td class="text-center"></td>
            <td class="text-center"></td>
            <td class="text-center">${soTreeMetricCell(b.maxMetric, b.level, b.activeWOs > 0)}</td>
            <td class="text-center font-bold">${b.completedItems}/${b.totalItems}</td>
            <td class="text-center">${soTreeProgressCell(b.pct)}</td>
            <td class="text-center font-bold">${soTreeFmtTon(b.completedWeight)}</td>
            <td class="text-center font-bold">${soTreeFmtTon(b.totalWeight)}</td>
            <td class="text-center">${soTreeStatusBadge(b.status)}</td>
            <td class="text-center">${soTreeSoAlertHtml(b)}</td>
        </tr>`;

        b.workOrders.forEach((e, idx) => {
            const wo = e.wo;
            const isLast = idx === b.workOrders.length - 1;
            const cls = 'so-wo-row' + (e.isActive && e.delay.level !== 'ok' ? ' ' + e.delay.level : '');
            let woStatus = 'In Progress';
            if (e.isArchived) woStatus = 'Archived';
            else if (e.isFinished) woStatus = 'Finished';
            else if (e.pct === 0) woStatus = 'Not Started';
            const iconColor = e.isArchived ? '#7c3aed' : (e.isFinished ? '#059669' : '#d97706');
            html += `<tr class="${cls}" data-so="${esc(b.salesOrder)}" style="${open ? '' : 'display:none;'}">
                <td style="text-align:left;padding-left:2rem;">
                    <div style="display:flex;align-items:center;gap:0.45rem;">
                        <span class="so-conn${isLast ? ' last' : ''}"></span>
                        <i class="fa-solid fa-file-lines" style="color:${iconColor};"></i>
                        <span style="font-weight:700;color:#1e293b;">${esc(wo.workOrderName)}</span>
                    </div>
                </td>
                <td class="text-center" style="font-size:0.78rem;">${esc(wo.projectName)}</td>
                <td class="text-center" style="font-size:0.78rem;">${esc(wo.type)} / ${esc(wo.model)}</td>
                <td class="text-center" style="font-size:0.78rem;">${esc(soTreeFmtDate(e.delay.created) || wo.date || '')}</td>
                <td class="text-center">${soTreeMetricCell(e.delay.metric, e.delay.level, e.isActive)}</td>
                <td class="text-center" style="font-size:0.78rem;">${e.doneItems}/${e.totalItems}</td>
                <td class="text-center">${soTreeProgressCell(e.pct)}</td>
                <td class="text-center" style="font-size:0.78rem;">${soTreeFmtTon(e.woDoneWt)}</td>
                <td class="text-center" style="font-size:0.78rem;">${soTreeFmtTon(e.woTotalWt)}</td>
                <td class="text-center">${soTreeStatusBadge(woStatus)}</td>
                <td class="text-center">${soTreeWoAlertHtml(e)}</td>
            </tr>`;
        });
    });
    html += soTreeTotalRow(buckets, 11, true);
    body.innerHTML = html;
}

function soTreeRenderSummary(buckets, header, body) {
    header.innerHTML = `<tr>
        <th style="width:22%">Sales Order</th><th>Project(s)</th><th>WOs (Finished/Total)</th><th>Items</th>
        <th style="min-width:110px">Progress %</th><th>Done Weight (ton)</th><th>Total Weight (ton)</th>
        <th>${soTreeMetricLabel()}</th><th>Status</th><th>Delay Alert</th>
    </tr>`;
    let html = '';
    buckets.forEach(b => {
        html += `<tr class="so-row so-row-static">
            <td style="text-align:left;">
                <div style="display:flex;align-items:center;gap:0.5rem;">
                    <i class="fa-solid fa-folder-open text-blue-700"></i>
                    <div style="flex:1;min-width:140px;">
                        <div style="font-weight:800;color:#0c4a6e;font-size:0.95rem;">${esc(b.salesOrder)}</div>
                        ${soTreeStackBar(b)}
                    </div>
                </div>
            </td>
            <td class="text-center" style="font-size:0.78rem;">${[...b.projects].map(esc).join(' • ')}</td>
            <td class="text-center font-bold">${b.finishedWOs}/${b.totalWOs}</td>
            <td class="text-center font-bold">${b.completedItems}/${b.totalItems}</td>
            <td class="text-center">${soTreeProgressCell(b.pct)}</td>
            <td class="text-center font-bold">${soTreeFmtTon(b.completedWeight)}</td>
            <td class="text-center font-bold">${soTreeFmtTon(b.totalWeight)}</td>
            <td class="text-center">${soTreeMetricCell(b.maxMetric, b.level, b.activeWOs > 0)}</td>
            <td class="text-center">${soTreeStatusBadge(b.status)}</td>
            <td class="text-center">${soTreeSoAlertHtml(b)}</td>
        </tr>`;
    });
    html += soTreeTotalRow(buckets, 10, false);
    body.innerHTML = html;
}

function soTreeTotalRow(buckets, cols, detail) {
    const sum = (k) => buckets.reduce((s, b) => s + b[k], 0);
    const totalWt = sum('totalWeight'), doneWt = sum('completedWeight');
    const pct = totalWt > 0 ? (doneWt / totalWt * 100) : 0;
    const late = sum('delayedWOs') + sum('criticalWOs');
    const items = `${sum('completedItems')}/${sum('totalItems')}`;
    const alert = late > 0 ? `${late} delayed/critical` : 'On track';
    if (detail) {
        return `<tr class="so-total-row"><td style="text-align:left;">TOTAL (${buckets.length} SO / ${sum('totalWOs')} WO)</td><td></td><td></td><td></td><td></td>
            <td class="text-center">${items}</td><td class="text-center">${pct.toFixed(1)}%</td>
            <td class="text-center">${soTreeFmtTon(doneWt)}</td><td class="text-center">${soTreeFmtTon(totalWt)}</td><td></td><td class="text-center">${alert}</td></tr>`;
    }
    return `<tr class="so-total-row"><td style="text-align:left;">TOTAL (${buckets.length} SO)</td><td></td>
        <td class="text-center">${sum('finishedWOs')}/${sum('totalWOs')}</td><td class="text-center">${items}</td>
        <td class="text-center">${pct.toFixed(1)}%</td><td class="text-center">${soTreeFmtTon(doneWt)}</td><td class="text-center">${soTreeFmtTon(totalWt)}</td>
        <td></td><td></td><td class="text-center">${alert}</td></tr>`;
}

function soTreeApplyExpansion() {
    const st = soTreeState;
    const searching = !!(st.search || '').trim();
    document.querySelectorAll('#reportTableBody tr.so-row[data-so]').forEach(tr => {
        const open = searching || st.expanded.has(tr.dataset.so);
        tr.classList.toggle('open', open);
    });
    document.querySelectorAll('#reportTableBody tr.so-wo-row').forEach(tr => {
        const open = searching || st.expanded.has(tr.dataset.so);
        tr.style.display = open ? '' : 'none';
    });
}
function soTreeToggle(name) {
    const st = soTreeState;
    if (st.expanded.has(name)) st.expanded.delete(name); else st.expanded.add(name);
    soTreeApplyExpansion();
}
function soTreeExpandAll(open) {
    const st = soTreeState;
    st.expanded = new Set(open ? st.lastNames : []);
    soTreeApplyExpansion();
}
function soTreeSetSearch(value) {
    const st = soTreeState;
    st.search = value || '';
    clearTimeout(st.searchTimer);
    st.searchTimer = setTimeout(soTreeRefresh, 150);
}
function soTreeSetSort(value) {
    soTreeState.sort = value || 'so';
    soTreeRefresh();
}
function soTreeFilterDelayed() {
    const sel = document.getElementById('treeStatusFilter');
    if (sel) sel.value = 'delayed';
    generateSalesOrderTree();
}

// ====== Populate Dropdowns ======
function populateTowerTypeDropdown() {
    const sel = document.getElementById('workOrderTowerType');
    sel.innerHTML = '<option value="" disabled selected>Select type...</option>';
    [...new Set(db.map(m => m.type))].forEach(t => { sel.innerHTML += `<option value="${t}">${t}</option>`; });
    document.getElementById('workOrderModel').innerHTML = '<option disabled selected>Select model...</option>';
}

function populateModelDropdown() {
    const type = document.getElementById('workOrderTowerType').value;
    const sel = document.getElementById('workOrderModel');
    sel.innerHTML = '<option disabled selected>Select model...</option>';
    if (type) db.filter(m => m.type === type).forEach(m => { sel.innerHTML += `<option value="${m.model}">${m.model}</option>`; });
}

function populateProductionTowerTypeDropdown() {
    const sel = document.getElementById('productionTowerType');
    sel.innerHTML = '<option disabled selected>Select type...</option>';
    [...new Set(db.map(m => m.type))].forEach(t => { sel.innerHTML += `<option value="${t}">${t}</option>`; });
    document.getElementById('productionModel').innerHTML = '<option disabled selected>Select model...</option>';
    document.getElementById('productionWorkOrder').innerHTML = '<option disabled selected>Select work order...</option>';
    document.getElementById('productionProject').innerHTML = '<option disabled selected>Will be filled automatically...</option>';
}

function populateProductionModelDropdown() {
    const type = document.getElementById('productionTowerType').value;
    const sel = document.getElementById('productionModel');
    sel.innerHTML = '<option disabled selected>Select model...</option>';
    if (type) db.filter(m => m.type === type).forEach(m => { sel.innerHTML += `<option value="${m.model}">${m.model}</option>`; });
}

function populateWorkOrderDropdown() {
    const type = document.getElementById('productionTowerType').value;
    const model = document.getElementById('productionModel').value;
    const sel = document.getElementById('productionWorkOrder');
    sel.innerHTML = '<option disabled selected>Select work order...</option>';
    if (type && model) workOrdersDB.filter(wo => wo.type === type && wo.model === model && !isWorkOrderCompleted(wo) && !wo.archived).forEach(wo => { sel.innerHTML += `<option value="${wo.id}" data-project="${wo.projectName}">${wo.workOrderName}</option>`; });
}

function populateProjectDropdown() {
    const woId = document.getElementById('productionWorkOrder').value;
    const sel = document.getElementById('productionProject');
    if (woId) { const wo = workOrdersDB.find(w => w.id === parseInt(woId)); if (wo) sel.innerHTML = `<option value="${wo.projectName}" selected>${wo.projectName}</option>`; }
    else sel.innerHTML = '<option disabled selected>Will be filled automatically...</option>';
}

function populateDailyReportWorkOrders() {
    const sel = document.getElementById('dailyReportWorkOrder');
    if (sel) {
        sel.innerHTML = '<option value="">All Work Orders</option>';
        workOrdersDB.forEach(wo => { sel.innerHTML += `<option value="${wo.id}">${wo.workOrderName} - ${wo.projectName}</option>`; });
    }
}

function populateReportDropdowns() {
    const sel1 = document.getElementById('reportWorkOrder');
    const sel2 = document.getElementById('detailReportWorkOrder');
    const allOption = '<option value="all">All Work Orders</option>';
    const placeholder = '<option disabled selected>Select work order...</option>';
    const opts = workOrdersDB.map(wo => {
        const display = `${wo.workOrderName} - ${wo.projectName}`;
        allWorkOrderOptions[wo.id] = display;
        return `<option value="${wo.id}">${display}</option>`;
    }).join('');
    if (sel1) { sel1.innerHTML = allOption + opts; sel1.setAttribute('data-all-options', allOption + opts); }
    if (sel2) { sel2.innerHTML = placeholder + opts; sel2.setAttribute('data-all-options', placeholder + opts); }
}

function filterWorkOrderSelect() {
    const search = document.getElementById('reportWorkOrderSearch').value.toLowerCase().trim();
    const sel = document.getElementById('reportWorkOrder');
    sel.querySelectorAll('option').forEach(opt => {
        const text = opt.textContent.toLowerCase();
        opt.style.display = (text.includes(search) || search === '') ? '' : 'none';
    });
    if (sel.value && sel.options[sel.selectedIndex]?.style.display === 'none') sel.value = 'all';
}

function filterDetailWorkOrderSelect() {
    const search = document.getElementById('detailReportWorkOrderSearch').value.toLowerCase().trim();
    const sel = document.getElementById('detailReportWorkOrder');
    sel.querySelectorAll('option').forEach(opt => {
        const text = opt.textContent.toLowerCase();
        opt.style.display = (text.includes(search) || search === '') ? '' : 'none';
    });
    if (sel.value && sel.options[sel.selectedIndex]?.style.display === 'none') sel.value = '';
}

function populateNCRWorkOrders() {
    const sel = document.getElementById('ncrWorkOrder');
    if (!sel) return;
    sel.innerHTML = '<option value="" disabled selected>Select work order...</option>';
    workOrdersDB.forEach(wo => { sel.innerHTML += `<option value="${wo.id}">${wo.workOrderName} - ${wo.projectName}</option>`; });
    const searchEl = document.getElementById('ncrWorkOrderSearch');
    if (searchEl) searchEl.value = '';
    const itemSel = document.getElementById('ncrItem');
    if (itemSel) itemSel.innerHTML = '<option value="" disabled selected>Select item...</option>';
    const itemSearchEl = document.getElementById('ncrItemSearch');
    if (itemSearchEl) itemSearchEl.value = '';
}

function filterNCRWorkOrderSelect() {
    const searchEl = document.getElementById('ncrWorkOrderSearch');
    const sel = document.getElementById('ncrWorkOrder');
    if (!searchEl || !sel) return;
    const search = searchEl.value.toLowerCase().trim();
    sel.querySelectorAll('option').forEach(opt => {
        const text = opt.textContent.toLowerCase();
        opt.style.display = (text.includes(search) || search === '') ? '' : 'none';
    });
    if (sel.value && sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].style.display === 'none') sel.value = '';
}

function filterNCRItemSelect() {
    const searchEl = document.getElementById('ncrItemSearch');
    const sel = document.getElementById('ncrItem');
    if (!searchEl || !sel) return;
    const search = searchEl.value.toLowerCase().trim();
    sel.querySelectorAll('option').forEach(opt => {
        const text = opt.textContent.toLowerCase();
        opt.style.display = (text.includes(search) || search === '') ? '' : 'none';
    });
    if (sel.value && sel.options[sel.selectedIndex] && sel.options[sel.selectedIndex].style.display === 'none') sel.value = '';
}

function populateShortageWorkOrders() {
    const sel = document.getElementById('shortageWorkOrder');
    if (sel) {
        sel.innerHTML = '<option value="">All Work Orders</option>';
        workOrdersDB.filter(wo => !isWorkOrderCompleted(wo)).forEach(wo => {
            sel.innerHTML += `<option value="${wo.id}">${wo.workOrderName} - ${wo.projectName}</option>`;
        });
    }
}

function populateStageSummarySalesOrders() {
    const sel = document.getElementById('stageSummarySO');
    if (!sel) return;
    const sos = getDistinctSalesOrders();
    sel.innerHTML = '<option value="">All Sales Orders</option>';
    sos.forEach(so => { sel.innerHTML += `<option value="${esc(so)}">${esc(so)}</option>`; });
}

function fillSalesOrderSelect(selectId) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    const prev = sel.value;
    const sos = getDistinctSalesOrders();
    sel.innerHTML = '<option value="">All Sales Orders</option>';
    sos.forEach(so => { sel.innerHTML += `<option value="${esc(so)}">${esc(so)}</option>`; });
    if (prev && sos.includes(prev)) sel.value = prev;
}

function populateWorkOrdersForOperation() {
    const phase = document.getElementById('operationPhase').value;
    const salesOrder = document.getElementById('operationSalesOrder')?.value || '';
    const sel = document.getElementById('operationWorkOrder');
    const catContainer = document.getElementById('machineCategoryContainer');
    if (catContainer) catContainer.classList.remove('hidden');
    if (sel) {
        sel.innerHTML = '<option value="">All Work Orders</option>';
        let filtered = workOrdersDB;
        if (salesOrder) filtered = filtered.filter(wo => wo.salesOrderNumber === salesOrder);
        if (phase) filtered = filtered.filter(wo => wo.items.some(it => it.operations.some(op => getOperationPhase(op.name) === phase)));
        filtered.forEach(wo => { sel.innerHTML += `<option value="${wo.id}">${wo.workOrderName} - ${wo.projectName}</option>`; });
    }
}

// ====== Rendering lists ======
function renderModelsList() {
    const container = document.getElementById('modelsContainer');
    const search = document.getElementById('searchInput').value.toLowerCase();
    container.innerHTML = '';
    const filtered = db.filter(e => e.model.toLowerCase().includes(search) || e.type.toLowerCase().includes(search));
    if (filtered.length === 0) { container.innerHTML = '<p class="text-center text-gray-500 py-10">No models.</p>'; return; }
    filtered.forEach(entry => {
        const isLinked = workOrdersDB.some(wo => wo.type === entry.type && wo.model === entry.model);
        const card = document.createElement('div');
        card.className = 'card cursor-pointer hover:shadow-lg transition';
        card.innerHTML = `<div class="flex items-center gap-4 p-4"><div class="bg-gray-100 p-3 rounded-full"><i class="fa-solid fa-tower-cell text-blue-600 text-xl"></i></div><div class="flex-1"><h4 class="font-bold">${entry.model}</h4><div class="flex gap-2 mt-2"><span class="badge badge-primary">${entry.type}</span><span class="text-xs text-gray-500">Items: ${entry.items.length}</span>${isLinked ? '<span class="text-xs text-yellow-600"><i class="fa-solid fa-link"></i> Linked</span>' : ''}</div><p class="text-xs text-gray-400 mt-2">${entry.date}</p></div><div class="flex flex-col gap-2"><i class="fa-solid fa-chevron-right text-gray-400"></i>${!isLinked && hasPermission('canDeleteModel') ? `<button onclick="event.stopPropagation(); showDeleteModelConfirmation(${entry.id})" class="delete-btn text-red-500 hover:text-red-700 text-sm"><i class="fa-solid fa-trash"></i></button>` : ''}</div></div>`;
        card.onclick = () => showDetails(entry.id);
        container.appendChild(card);
    });
}

function renderWorkOrdersList() {
    const container = document.getElementById('workOrdersContainer');
    const search = document.getElementById('workOrderSearch').value.toLowerCase();
    container.innerHTML = '';
    let filtered = workOrdersDB;
    if (currentWorkOrderFilter === 'inprogress') filtered = workOrdersDB.filter(wo => !isWorkOrderCompleted(wo) && !wo.archived);
    else if (currentWorkOrderFilter === 'finished') filtered = workOrdersDB.filter(wo => isWorkOrderCompleted(wo) || wo.archived === true);
    filtered = filtered.filter(wo =>
        wo.workOrderName.toLowerCase().includes(search) ||
        wo.projectName.toLowerCase().includes(search) ||
        wo.salesOrderNumber.toLowerCase().includes(search) ||
        wo.model.toLowerCase().includes(search) ||
        wo.type.toLowerCase().includes(search)
    );
    if (filtered.length === 0) { container.innerHTML = `<p class="text-center text-gray-500 col-span-2 py-10">No work orders.</p>`; return; }
    filtered.forEach(wo => {
        const total = wo.items.length;
        const completed = wo.items.filter(i => i.status === 'Completed').length;
        const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
        const isFinished = isWorkOrderCompleted(wo);
        const hasProduction = productionDB.some(r => r.workOrderId === wo.id);
        const completionPercent = getWorkOrderCompletionPercentage(wo);
        const isArchived = wo.archived === true;
        const canMarkFinished = (!isFinished && completionPercent >= 90 && !wo.archived && currentWorkOrderFilter === 'inprogress' && hasPermission('canMarkAsFinished'));
        const card = document.createElement('div');
        card.className = 'card cursor-pointer hover:shadow-lg transition';
        let totalOrderWeight = 0, completedOrderWeight = 0;
        wo.items.forEach(item => {
            const w = item.weightPerPiece || 0;
            totalOrderWeight += item.quantity * w;
            completedOrderWeight += (item.completedQuantity || 0) * w;
        });
        card.innerHTML = `<div class="p-4"><div class="flex justify-between"><div><h4 class="font-bold">${wo.workOrderName} ${isArchived ? '<span class="text-xs text-gray-400 ml-2">(Archived → Finished)</span>' : ''}</h4><div class="flex gap-2 mt-2 flex-wrap"><span class="badge badge-info">${wo.type}</span><span class="badge badge-warning">${wo.model}</span><span class="badge badge-success text-xs">${wo.date}</span>${isFinished || isArchived ? '<span class="badge badge-primary"><i class="fa-solid fa-check-circle"></i> Finished</span>' : '<span class="badge badge-warning"><i class="fa-solid fa-spinner"></i> In Progress</span>'}${hasProduction ? '<span class="text-xs text-yellow-600"><i class="fa-solid fa-industry"></i> Has Production</span>' : ''}${isArchived ? '<span class="badge badge-secondary"><i class="fa-solid fa-archive"></i> Archived</span>' : ''}<span class="text-xs text-gray-500">Weight: ${(completedOrderWeight / 1000).toFixed(2)} / ${(totalOrderWeight / 1000).toFixed(2)} tons</span></div></div><div class="text-right"><span class="block font-bold text-green-600">${completed}/${total}</span><div class="progress w-24 mt-1"><div class="progress-bar" style="width:${progress}%"></div></div>${!isFinished ? `<span class="text-xs text-gray-500 block mt-1">Overall: ${completionPercent.toFixed(1)}%</span>` : ''}</div></div><div class="mt-4 pt-4 border-t"><div class="flex justify-between"><div class="text-sm"><span><i class="fa-solid fa-building mr-1"></i> ${wo.projectName}</span><span class="block mt-1"><i class="fa-solid fa-tag mr-1"></i> ${wo.salesOrderNumber}</span><span class="block mt-1 text-xs text-gray-500">Total Weight: ${(totalOrderWeight / 1000).toFixed(2)} tons</span></div><div class="flex flex-col items-end gap-2"><div class="text-xs text-gray-500">${wo.creationTime}</div><div class="flex gap-2">${canMarkFinished ? `<button onclick="event.stopPropagation(); markWorkOrderAsFinished(${wo.id})" class="btn btn-success btn-lg font-bold text-white px-6 py-2 rounded-lg border-4 border-green-700 shadow-lg hover:shadow-xl transform hover:scale-105 transition-all duration-200 flex items-center gap-2" style="background: linear-gradient(135deg, #22c55e, #16a34a); border-color: #15803d; box-shadow: 0 4px 15px rgba(34, 197, 94, 0.4);"><i class="fa-solid fa-flag-checkered text-xl"></i><span class="text-lg">${translations[currentLanguage].markAsFinished || 'Mark as Finished'}</span></button>` : ''}${!hasProduction && !wo.archived && hasPermission('canDeleteWorkOrder') ? `<button onclick="event.stopPropagation(); showDeleteWorkOrderConfirmation(${wo.id})" class="delete-btn text-red-500 text-sm"><i class="fa-solid fa-trash"></i></button>` : ''}</div></div></div></div></div>`;
        card.onclick = () => showWorkOrderDetails(wo.id);
        container.appendChild(card);
    });
}

async function markWorkOrderAsFinished(id) {
    if (!hasPermission('canMarkAsFinished')) { showToast('❌ غير مسموح لك بإنهاء أوامر العمل.', 'error'); return; }
    const t = translations[currentLanguage];
    const wo = workOrdersDB.find(w => w.id === id);
    if (!wo) return;
    if (wo.archived) { showToast('⚠️ Work order is already finished', 'warning'); return; }
    const percent = getWorkOrderCompletionPercentage(wo);
    if (percent < 90) { showToast(`${t.minCompletionRequired} (${percent.toFixed(1)}%)`, 'warning'); return; }
    if (confirm(t.markAsFinishedConfirm)) {
        wo.archived = true;
        await saveToServer('workOrdersDB', workOrdersDB);
        await createProductionRecordsForArchivedOrders();
        renderWorkOrdersList(); renderDashboard();
        populateProductionTowerTypeDropdown(); populateDailyReportWorkOrders();
        populateNCRWorkOrders(); populateReportDropdowns();
        populateShortageWorkOrders(); populateWorkOrdersForOperation();
        showToast(`✅ Work order "${wo.workOrderName}" marked as Finished successfully!`, 'success');
    }
}

function showWorkOrderDetails(id) {
    const wo = workOrdersDB.find(o => o.id === id);
    if (!wo) return;
    currentWorkOrder = wo;
    document.getElementById('workOrderTitle').textContent = wo.workOrderName;
    document.getElementById('workOrderType').textContent = wo.type;
    document.getElementById('workOrderDate').textContent = wo.date;
    document.getElementById('workOrderProject').textContent = wo.projectName;
    document.getElementById('workOrderSalesNumber').textContent = wo.salesOrderNumber;
    document.getElementById('workOrderCreationDate').textContent = `${wo.date} - ${wo.creationTime}`;
    document.getElementById('workOrderTotalItems').textContent = wo.items.length;
    const tbody = document.getElementById('workOrderDetailsTableBody');
    const woRows = [];
    wo.items.forEach((item, idx) => {
        let opsHtml = '';
        item.operations.forEach(op => {
            const comp = item.completedOperations[op.name];
            const compQty = comp ? comp.completedQuantity : 0;
            const isComp = compQty >= item.quantity;
            let color = 'bg-gray-100 text-gray-700';
            if (isComp) color = 'bg-green-100 text-green-800';
            else if (compQty > 0) color = 'bg-yellow-100 text-yellow-800';
            opsHtml += `<div class="flex items-center text-xs p-1 rounded ${color} mb-1"><span class="font-semibold">${op.name}</span><span class="ml-1">(${compQty}/${item.quantity})</span>${isComp ? '<i class="fa-solid fa-check text-green-600 ml-1"></i>' : ''}</div>`;
        });
        const statusClass = item.status === 'Completed' ? 'status-completed' : (item.status === 'In Progress' ? 'status-in-progress' : 'status-pending');
        const isCompleted = item.status === 'Completed';
        const showBalanceComplete = (wo.archived === true) && !isCompleted && hasPermission('canRecordProduction');
        const approveBtn = (hasPermission('canApproveItem') && !isCompleted) ? `<button onclick="approveItem(${wo.id}, ${idx})" class="btn btn-success btn-sm"><i class="fa-solid fa-check-double"></i> اعتماد</button>` : '';
        const blockBtn = (hasPermission('canBlockItem') && !isCompleted) ? `<button onclick="blockItem(${wo.id}, ${idx})" class="btn btn-danger btn-sm"><i class="fa-solid fa-ban"></i> حظر</button>` : '';
        const extraActions = (approveBtn || blockBtn || showBalanceComplete) ? `<td class="text-center">${approveBtn} ${blockBtn} ${showBalanceComplete ? `<button onclick="completeItemAsBalance(${wo.id}, ${idx})" class="btn btn-primary btn-sm"><i class="fa-solid fa-scale-balanced"></i> ${translations[currentLanguage].balanceComplete || 'Complete as Balance'}</button>` : ''}</td>` : '<td></td>';
        woRows.push(`<tr><td class="text-center">${idx + 1}</td><td class="font-bold">${item.itemName}</td><td><span class="px-2 py-1 text-xs rounded-full ${item.section.startsWith('L') ? 'bg-indigo-100' : (item.section.startsWith('P') || item.section.startsWith('F')) ? 'bg-teal-100' : 'bg-pink-100'}">${item.section}</span></td><td class="text-center">${item.steelGrade || '-'}</td><td class="text-center">${item.length || '-'}</td><td class="font-bold ${item.status === 'Completed' ? 'text-green-700' : 'text-yellow-700'}">${item.completedQuantity || 0}/${item.quantity}</td><td class="font-bold">${item.weightPerPiece || 0}</td><td class="font-bold">${item.totalWeight || 0}</td><td class="text-center">${opsHtml}</td><td class="text-center"><span class="status-indicator ${statusClass}">${item.status}</span></td>${extraActions}</tr>`);
    });
    tbody.innerHTML = woRows.join('');
    document.getElementById('workOrderDetailsView').classList.remove('hidden');
    document.getElementById('workOrderDetailsView').scrollIntoView({ behavior: 'smooth' });
}

async function approveItem(workOrderId, itemIndex) {
    if (!hasPermission('canApproveItem')) { showToast('غير مسموح لك باعتماد البنود', 'error'); return; }
    const wo = workOrdersDB.find(w => w.id === workOrderId);
    if (!wo) return;
    const item = wo.items[itemIndex];
    if (!item) return;
    if (item.status === 'Completed') { showToast('البند مكتمل بالفعل', 'warning'); return; }
    let allDone = true;
    for (const op of item.operations) {
        const comp = item.completedOperations[op.name];
        if (!comp || comp.completedQuantity < item.quantity) { allDone = false; break; }
    }
    if (allDone) {
        item.status = 'Completed';
        item.completedQuantity = recalcItemCompletedQuantity(item);
        await saveToServer('workOrdersDB', workOrdersDB);
        showWorkOrderDetails(workOrderId); renderWorkOrdersList(); renderDashboard();
        showToast('تم اعتماد البند كمنتج تام', 'success');
        return;
    }
    const today = new Date().toISOString().split('T')[0];
    let anyNewRecord = false;
    for (const op of item.operations) {
        const comp = item.completedOperations[op.name];
        const currentQty = comp ? comp.completedQuantity : 0;
        if (currentQty < item.quantity) {
            const remaining = item.quantity - currentQty;
            if (remaining > 0) {
                const machineInfo = getMachineForOperation(op.name, item.section);
                let machine = machineInfo.machine;
                if (machine === "206/20.20/10.10") machine = "206";
                const prodWeight = Math.round(item.weightPerPiece * remaining);
                const prodRec = {
                    id: Date.now() + Math.random(),
                    workOrderId: wo.id, workOrderName: wo.workOrderName,
                    projectName: wo.projectName, towerType: wo.type, model: wo.model,
                    shift: 'Balance', machine: machine, operator: 'Balance', date: today,
                    itemName: item.itemName, itemSection: item.section, operation: op.name,
                    quantity: remaining, rejectedQty: 0, producedWeight: prodWeight,
                    weightPerPiece: item.weightPerPiece, totalItemWeight: item.totalWeight,
                    notes: `تم الإكمال تلقائياً بواسطة اعتماد البند في ${today}`,
                    timestamp: Date.now(), recordedBy: currentUser ? currentUser.username : 'system'
                };
                productionDB.push(prodRec);
                if (!item.completedOperations[op.name]) item.completedOperations[op.name] = { completed: false, completedQuantity: 0, totalRequired: item.quantity };
                item.completedOperations[op.name].completedQuantity = item.quantity;
                item.completedOperations[op.name].completed = true;
                anyNewRecord = true;
            }
        }
    }
    if (!anyNewRecord) {
        item.status = 'Completed';
        item.completedQuantity = recalcItemCompletedQuantity(item);
        await saveToServer('workOrdersDB', workOrdersDB);
        showWorkOrderDetails(workOrderId); renderWorkOrdersList(); renderDashboard();
        showToast('تم اعتماد البند كمنتج تام', 'success');
        return;
    }
    item.completedQuantity = recalcItemCompletedQuantity(item);
    recalcItemStatus(item);
    const woSaveResult = await saveToServer('workOrdersDB', workOrdersDB);
    if (!woSaveResult || !woSaveResult.success) { showToast('تعذّر حفظ تحديث أمر الشغل على الخادم.', 'error'); return; }
    await flushNewProductionRecords();
    showWorkOrderDetails(workOrderId); renderWorkOrdersList(); renderDashboard();
    updateStats(); await updateIdealRatesFromActual();
    showToast('تم اعتماد البند كمنتج تام مع إكمال العمليات الناقصة تلقائياً', 'success');
}

async function blockItem(workOrderId, itemIndex) {
    if (!hasPermission('canBlockItem')) { showToast('غير مسموح لك بحظر البنود', 'error'); return; }
    const wo = workOrdersDB.find(w => w.id === workOrderId);
    if (!wo) return;
    const item = wo.items[itemIndex];
    if (!item) return;
    if (item.status === 'Blocked') { showToast('البند محظور بالفعل', 'warning'); return; }
    item.status = 'Blocked';
    await saveToServer('workOrdersDB', workOrdersDB);
    showWorkOrderDetails(workOrderId); renderWorkOrdersList(); renderDashboard();
    showToast('تم حظر البند', 'success');
}

async function completeItemAsBalance(workOrderId, itemIndex) {
    if (!hasPermission('canRecordProduction')) { showToast('غير مسموح لك بإكمال البند كـ Balance', 'error'); return; }
    const wo = workOrdersDB.find(w => w.id === workOrderId);
    if (!wo) { showToast('Work order not found', 'error'); return; }
    const item = wo.items[itemIndex];
    if (!item) { showToast('Item not found', 'error'); return; }
    if (item.status === 'Completed') { showToast('Item already completed', 'warning'); return; }
    let minCompleted = Infinity;
    let hasOperations = false;
    item.operations.forEach(op => {
        hasOperations = true;
        const comp = item.completedOperations[op.name];
        const compQty = comp ? comp.completedQuantity : 0;
        if (compQty < minCompleted) minCompleted = compQty;
    });
    if (!hasOperations) { showToast('Item has no operations to complete', 'warning'); return; }
    if (minCompleted === Infinity) minCompleted = 0;
    const remaining = item.quantity - minCompleted;
    if (remaining <= 0) { showToast('No remaining quantity to complete', 'warning'); return; }
    const completionDate = prompt('Enter completion date (YYYY-MM-DD):', new Date().toISOString().split('T')[0]);
    if (!completionDate || !/^\d{4}-\d{2}-\d{2}$/.test(completionDate)) { showToast('Invalid or missing date', 'warning'); return; }
    if (!confirm(`Complete item "${item.itemName}" with remaining ${remaining} pcs as Balance on ${completionDate}?`)) return;
    showLoading(translations[currentLanguage].processing);
    try {
        let updated = false;
        for (const op of item.operations) {
            const comp = item.completedOperations[op.name];
            const compQty = comp ? comp.completedQuantity : 0;
            if (compQty < item.quantity) {
                const qtyToComplete = item.quantity - compQty;
                const machineInfo = getMachineForOperation(op.name, item.section);
                let machine = machineInfo.machine;
                if (machine === "206/20.20/10.10") machine = "206";
                const prodWeight = Math.round(item.weightPerPiece * qtyToComplete);
                const prodRec = {
                    id: Date.now() + Math.random(),
                    workOrderId: wo.id, workOrderName: wo.workOrderName,
                    projectName: wo.projectName, towerType: wo.type, model: wo.model,
                    shift: 'Balance', machine: machine, operator: 'Balance', date: completionDate,
                    itemName: item.itemName, itemSection: item.section, operation: op.name,
                    quantity: qtyToComplete, rejectedQty: 0, producedWeight: prodWeight,
                    weightPerPiece: item.weightPerPiece, totalItemWeight: item.totalWeight,
                    notes: `Auto-completed from Finished Work Order on ${completionDate} by Balance`,
                    timestamp: Date.now(), recordedBy: currentUser ? currentUser.username : 'system'
                };
                productionDB.push(prodRec);
                if (!item.completedOperations[op.name]) item.completedOperations[op.name] = { completed: false, completedQuantity: 0, totalRequired: item.quantity };
                item.completedOperations[op.name].completedQuantity = item.quantity;
                item.completedOperations[op.name].completed = true;
                updated = true;
            }
        }
        if (!updated) { hideLoading(); showToast('No pending operations to complete', 'info'); return; }
        item.completedQuantity = recalcItemCompletedQuantity(item);
        recalcItemStatus(item);
        const woSaveResult = await saveToServer('workOrdersDB', workOrdersDB);
        if (!woSaveResult || !woSaveResult.success) { hideLoading(); showToast('تعذّر حفظ تحديث أمر الشغل على الخادم.', 'error'); return; }
        await flushNewProductionRecords();
        renderWorkOrdersList(); renderDashboard(); updateStats();
        await updateIdealRatesFromActual();
        showWorkOrderDetails(wo.id);
        populateDailyReportWorkOrders(); populateNCRWorkOrders(); populateReportDropdowns();
        populateShortageWorkOrders(); populateWorkOrdersForOperation();
        hideLoading();
        showToast(`Item "${item.itemName}" completed successfully with Balance operator`, 'success');
    } catch (err) {
        console.error(err);
        hideLoading();
        showToast('Error completing item: ' + err.message, 'error');
    }
}

function hideWorkOrderDetails() { document.getElementById('workOrderDetailsView').classList.add('hidden'); }
function showDetails(id) {
    const entry = db.find(m => m.id === id);
    if (!entry) return;
    document.getElementById('viewTitle').textContent = entry.model;
    document.getElementById('viewType').textContent = `${entry.type} - ${entry.date}`;
    const tbody = document.getElementById('detailsTableBody');
    const rows = [];
    entry.items.forEach((item, idx) => {
        const opsSequence = item.operations.map(op => op.name).join(' ← ');
        const sect = item.section.toString().trim().toUpperCase();
        const sectClass = sect.startsWith('L') ? 'bg-indigo-100' : (sect.startsWith('P') || sect.startsWith('F')) ? 'bg-teal-100' : 'bg-pink-100';
        rows.push(`<tr><td class="text-center">${idx + 1}</td><td class="font-bold">${esc(item.itemName)}</td><td class="text-center"><span class="px-2 py-1 text-xs rounded-full ${sectClass}">${esc(item.section)}</span></td><td class="text-center">${esc(item.steelGrade || '-')}</td><td class="text-center">${esc(opsSequence)}</td></tr>`);
    });
    tbody.innerHTML = rows.length ? rows.join('') : '<tr><td colspan="5" class="text-center py-4">No items</td></tr>';
    document.getElementById('detailsView').classList.remove('hidden');
    document.getElementById('detailsView').scrollIntoView({ behavior: 'smooth' });
}
function hideDetails() { document.getElementById('detailsView').classList.add('hidden'); }
function hideProductionDetails() { document.getElementById('productionDetailsView').classList.add('hidden'); }
function hideReportResults() {
    document.getElementById('reportResults').classList.add('hidden');
    const strip = document.getElementById('reportSummaryStrip');
    if (strip) strip.innerHTML = '';
}

function showProductionDetails(id) {
    const rec = productionDB.find(r => r.id === id);
    if (!rec) return;
    currentProduction = rec;
    document.getElementById('productionTitle').textContent = rec.itemName;
    document.getElementById('productionType').textContent = rec.towerType;
    document.getElementById('productionShiftBadge').textContent = rec.shift;
    document.getElementById('productionDateBadge').textContent = rec.date;
    document.getElementById('productionProjectDetail').textContent = rec.projectName;
    document.getElementById('productionMachineDetail').textContent = rec.machine;
    document.getElementById('productionOperatorDetail').textContent = rec.operator || 'Not specified';
    document.getElementById('productionQuantityDetail').textContent = `${rec.quantity} pieces`;
    document.getElementById('productionWeightDetail').textContent = `${rec.producedWeight || '0'} kg`;
    const tbody = document.getElementById('productionDetailsTableBody');
    tbody.innerHTML = `<tr><td class="text-center">1</td><td class="font-bold">${esc(rec.itemName)}</td><td><span class="px-2 py-1 text-xs rounded-full ${rec.itemSection.startsWith('L') ? 'bg-indigo-100' : (rec.itemSection.startsWith('P') || rec.itemSection.startsWith('F')) ? 'bg-teal-100' : 'bg-pink-100'}">${esc(rec.itemSection)}</span></td><td class="text-center">${esc(rec.operation)}</td><td class="text-center"><span class="badge badge-success font-bold">Completed</span></td><td class="font-bold text-purple-700">${rec.quantity}</td><td class="font-bold text-green-700">${rec.producedWeight || '0'} kg</td><tr>`;
    document.getElementById('productionDetailsView').classList.remove('hidden');
    document.getElementById('productionDetailsView').scrollIntoView({ behavior: 'smooth' });
}

function renderProductionList() {
    const container = document.getElementById('productionContainer');
    if (!container) return;
    const searchEl = document.getElementById('productionSearch');
    const search = searchEl ? searchEl.value.toLowerCase().trim() : '';
    const today = getLocalDateStr();
    let records = productionDB.filter(r => getLocalDateStr(new Date(r.timestamp)) === today);
    if (search) {
        records = records.filter(r =>
            (r.itemName || '').toLowerCase().includes(search) ||
            (r.operation || '').toLowerCase().includes(search) ||
            (r.machine || '').toLowerCase().includes(search) ||
            (r.workOrderName || '').toLowerCase().includes(search) ||
            (r.operator || '').toLowerCase().includes(search)
        );
    }
    records.sort((a, b) => b.timestamp - a.timestamp);
    if (records.length === 0) { container.innerHTML = '<p class="text-center text-gray-500 py-10">No production records entered today.</p>'; return; }
    const canDelete = hasPermission('canDeleteProduction');
    container.innerHTML = records.map(r => `<div class="card cursor-pointer hover:shadow-lg transition"><div class="p-4 flex items-center justify-between gap-4" onclick="showProductionDetails(${r.id})"><div class="flex-1"><h4 class="font-bold">${esc(r.itemName)}</h4><div class="flex gap-2 mt-2 flex-wrap"><span class="badge badge-info">${esc(r.operation)}</span><span class="badge badge-warning">${esc(r.machine)}</span><span class="badge badge-success text-xs">${esc(r.date)} - ${esc(r.shift)}</span></div><div class="text-sm text-gray-500 mt-2"><span><i class="fa-solid fa-building mr-1"></i> ${esc(r.workOrderName)}</span><span class="mx-2">|</span><span><i class="fa-solid fa-user mr-1"></i> ${esc(r.operator || 'Not specified')}</span></div></div><div class="text-right"><span class="block font-bold text-purple-700">${r.quantity} pcs</span><span class="block text-sm text-green-700">${r.producedWeight || 0} kg</span></div></div>${canDelete ? `<div class="px-4 pb-3 flex justify-end"><button onclick="event.stopPropagation(); showDeleteProductionConfirmation(${r.id})" class="delete-btn text-red-500 hover:text-red-700 text-sm"><i class="fa-solid fa-trash"></i></button></div>` : ''}</div>`).join('');
}

function handleFileSelect(e) {
    const file = e.target.files[0];
    const fn = document.getElementById('fileName');
    if (file) {
        fn.textContent = `File uploaded: ${file.name}`; fn.classList.remove('hidden');
        const reader = new FileReader();
        reader.onload = function (ev) {
            const data = new Uint8Array(ev.target.result);
            const wb = XLSX.read(data, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            currentExcelData = XLSX.utils.sheet_to_json(ws, { header: 1 });
        };
        reader.readAsArrayBuffer(file);
        showToast(translations[currentLanguage].fileLoaded, 'success');
    }
}

function handleWorkOrderFileSelect(e) {
    const file = e.target.files[0];
    const fn = document.getElementById('workOrderFileName');
    if (file) {
        fn.textContent = `File uploaded: ${file.name}`; fn.classList.remove('hidden');
        const reader = new FileReader();
        reader.onload = function (ev) {
            const data = new Uint8Array(ev.target.result);
            const wb = XLSX.read(data, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            currentWorkOrderData = XLSX.utils.sheet_to_json(ws, { header: 1 });
        };
        reader.readAsArrayBuffer(file);
        showToast(translations[currentLanguage].woFileLoaded, 'success');
    }
}

async function processData() {
    if (!hasPermission('canCreateModel')) { showToast('غير مسموح لك بإضافة نماذج', 'error'); return; }
    const type = document.getElementById('towerType').value;
    const model = document.getElementById('modelName').value.trim();
    if (!type || !model) { showToast('Please select tower type and enter model name', 'warning'); return; }
    if (!currentExcelData || currentExcelData.length === 0) { showToast('Please upload a valid Excel file', 'warning'); return; }
    try {
        showLoading(translations[currentLanguage].processing);
        const items = [];
        for (let i = 1; i < currentExcelData.length; i++) {
            const row = currentExcelData[i];
            if (!row || row.length < 3) continue;
            const itemName = row[0], section = row[1], steelGrade = row[2];
            if (!itemName || !section) continue;
            let ops = [];
            for (let j = 3; j <= 7; j++) {
                const op = row[j];
                if (op && op.trim()) {
                    const mi = getMachineForOperation(op, section);
                    ops.push({ name: op, machine: mi.machine, type: mi.type });
                }
            }
            const sect = section.toString().trim().toUpperCase();
            if ((sect.startsWith('P') || sect.startsWith('F')) && ops.some(o => o.name.toLowerCase().includes('bend'))) {
                ops = ops.filter(o => !o.name.toLowerCase().includes('drill'));
            }
            ops = normalizeItemOperations(ops);
            if (ops.length) items.push({ itemName, section, steelGrade, operations: ops });
        }
        if (items.length === 0) { hideLoading(); showToast('No valid data found', 'error'); return; }
        db = db.filter(m => m.model !== model);
        db.push({ id: Date.now(), type, model, date: new Date().toLocaleDateString(), items });
        await saveAllData();
        updateStats(); renderModelsList(); populateTowerTypeDropdown(); populateProductionTowerTypeDropdown();
        document.getElementById('uploadForm').reset(); document.getElementById('fileName').classList.add('hidden'); currentExcelData = [];
        if (ENTRY_PANEL_AUTO_CLOSE) closeEntryPanel('models');
        hideLoading(); showToast(translations[currentLanguage].modelSaved, 'success');
    } catch (err) { hideLoading(); showToast('Error processing data', 'error'); console.error(err); }
}

async function processWorkOrder() {
    if (!hasPermission('canCreateWorkOrder')) { showToast('غير مسموح لك بإنشاء أوامر العمل', 'error'); return; }
    const woName = document.getElementById('workOrderName').value.trim();
    const projName = document.getElementById('projectName').value.trim();
    const soNum = document.getElementById('salesOrderNumber').value.trim();
    const type = document.getElementById('workOrderTowerType').value;
    const model = document.getElementById('workOrderModel').value;
    if (!woName || !projName || !soNum || !type || !model) { showToast('Please fill all fields', 'warning'); return; }
    if (!currentWorkOrderData || currentWorkOrderData.length === 0) { showToast('Please upload work order file', 'warning'); return; }
    if (workOrdersDB.find(w => w.workOrderName === woName)) { showToast('Work order name already exists', 'warning'); return; }
    const modelData = db.find(m => m.type === type && m.model === model);
    if (!modelData) { showToast('Model not found', 'error'); return; }
    try {
        showLoading(translations[currentLanguage].processing);
        const items = [];
        for (let i = 1; i < currentWorkOrderData.length; i++) {
            const row = currentWorkOrderData[i];
            if (!row || row.length < 7) continue;
            const itemName = row[0], section = row[1], steelGrade = row[2], length = row[3];
            const weightPerPiece = Math.round(parseFloat(row[4]) || 0);
            const quantity = parseInt(row[5]) || 0;
            const totalWeight = Math.round(parseFloat(row[6]) || (weightPerPiece * quantity));
            let matchingItem = modelData.items.find(it => it.itemName === itemName);
            let ops = [];
            if (matchingItem) ops = matchingItem.operations;
            else {
                matchingItem = modelData.items.find(it => it.section === section);
                if (matchingItem) ops = matchingItem.operations;
                else ops = [{ name: "No specific operations", machine: "To be determined", type: "General" }];
            }
            ops = normalizeItemOperations(ops);
            const completedOps = {};
            ops.forEach(op => { completedOps[op.name] = { completed: false, completedQuantity: 0, totalRequired: quantity }; });
            items.push({ itemName, section, steelGrade, length, weightPerPiece, quantity, totalWeight, operations: ops, completedOperations: completedOps, completedQuantity: 0, status: 'In Progress' });
        }
        if (items.length === 0) { hideLoading(); showToast('No valid data', 'error'); return; }
        const workOrder = {
            id: Date.now(), workOrderName: woName, projectName: projName, salesOrderNumber: soNum,
            type, model, date: new Date().toLocaleDateString(),
            creationTime: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            timestamp: Date.now(), items, fileName: document.getElementById('workOrderFile').files[0]?.name || "Unknown",
            archived: false
        };
        workOrdersDB.push(workOrder);
        await saveToServer('workOrdersDB', workOrdersDB);
        currentWorkOrder = workOrder;
        document.getElementById('workOrderForm').reset(); document.getElementById('workOrderFileName').classList.add('hidden'); currentWorkOrderData = [];
        if (ENTRY_PANEL_AUTO_CLOSE) closeEntryPanel('workOrder');
        populateTowerTypeDropdown(); populateProductionTowerTypeDropdown(); populateDailyReportWorkOrders(); populateNCRWorkOrders();
        updateStats(); renderWorkOrdersList(); renderDashboard();
        showWorkOrderDetails(workOrder.id);
        hideLoading(); showToast(translations[currentLanguage].woProcessed, 'success');
    } catch (err) { hideLoading(); showToast('Error processing work order', 'error'); console.error(err); }
}

function getMachineForOperation(opName, section) {
    const op = opName.toString().trim().toLowerCase();
    const sect = section.toString().trim().toUpperCase();
    const isSheet = sect.startsWith('P') || sect.startsWith('F');
    if (isSheet) {
        if (op.includes('shear') || op.includes('cutting') || op.includes('crop')) return { machine: "Shear", type: 'shearing' };
        if (op.includes('minimum') || op.includes('min')) return { machine: "83P", type: 'minimum' };
        if (op.includes('bend')) return { machine: "CNC Bending", type: 'bending' };
        if (op.includes('finish')) return { machine: "Finishing", type: 'finish' };
    }
    const isAngle = sect.startsWith('L');
    if (isAngle && (op.includes('min') || op === 'minimum')) return { machine: "206", type: 'primary' };
    if (op.includes('crop') || op.includes('cut')) return { machine: "Cropping", type: 'cutting' };
    if (op.includes('bend')) return { machine: "Press", type: 'forming' };
    if (op.includes('drill')) return { machine: "Drill", type: 'drilling' };
    if (op.includes('chamfer')) return { machine: "Chamfering", type: 'chamfering' };
    if (op.includes('finish')) return { machine: "Finishing", type: 'finish' };
    return { machine: "Standard", type: 'general' };
}

function getOperationPhase(opName) {
    const o = opName.toLowerCase();
    if (o.includes('minimum') || o.includes('min')) return 'minimum';
    if (o.includes('crop') || o.includes('cut')) return 'crop';
    if (o.includes('shear')) return 'shear';
    if (o.includes('bend')) return 'bend';
    if (o.includes('drill')) return 'drill';
    if (o.includes('chamfer')) return 'chamfer';
    if (o.includes('finish')) return 'finish';
    return 'general';
}

function onTowerTypeChange() { const t = document.getElementById('productionTowerType').value; if (t) { populateProductionModelDropdown(); saveProductionPreferences(); } }
function onModelChange() { const m = document.getElementById('productionModel').value; if (m) { populateWorkOrderDropdown(); saveProductionPreferences(); } }
function onWorkOrderChange() { const wo = document.getElementById('productionWorkOrder').value; if (wo) { populateProjectDropdown(); saveProductionPreferences(); } }
function onMachineChange() {
    const machine = document.getElementById('productionMachine').value;
    if (machine) {
        updateOperatorsDropdown();
        loadAvailableItems();
        saveProductionPreferences();
        const balanceContainer = document.getElementById('balanceToggleContainer');
        if (balanceContainer) {
            if (machine === 'Finishing') {
                balanceContainer.classList.remove('hidden');
                const toggle = document.getElementById('balanceToggle');
                if (toggle) { toggle.checked = false; balanceMode = false; }
            } else {
                balanceContainer.classList.add('hidden');
                const toggle = document.getElementById('balanceToggle');
                if (toggle && toggle.checked) { toggle.checked = false; balanceMode = false; }
            }
        }
    }
}

function toggleBalanceMode() {
    const toggle = document.getElementById('balanceToggle');
    balanceMode = toggle ? toggle.checked : false;
    const machine = document.getElementById('productionMachine').value;
    if (machine === 'Finishing') loadAvailableItems();
}

function loadAvailableItems() {
    const machine = document.getElementById('productionMachine').value;
    const woId = document.getElementById('productionWorkOrder').value;
    if (!machine || !woId) { showToast('Please select machine and work order first', 'warning'); return; }
    const wo = workOrdersDB.find(w => w.id === parseInt(woId));
    if (!wo) return;
    currentAvailableItems = [];
    let has = false;
    wo.items.forEach((item, idx) => {
        if (item.status === 'Completed') return;
        const isSheet = item.section.toString().trim().toUpperCase().startsWith('P') || item.section.toString().trim().toUpperCase().startsWith('F');
        if (machine === 'Finishing') {
            const finishingOp = item.operations.find(op => getOperationPhase(op.name) === 'finish');
            if (!finishingOp) return;
            const completedFinishing = item.completedOperations[finishingOp.name] ? item.completedOperations[finishingOp.name].completedQuantity : 0;
            if (completedFinishing >= item.quantity) return;
            let canShow = false;
            if (balanceMode) canShow = true;
            else {
                const finishIndex = item.operations.findIndex(op => op.name === finishingOp.name);
                let allPrevComplete = true;
                for (let i = 0; i < finishIndex; i++) {
                    const prevOp = item.operations[i];
                    const prevComp = item.completedOperations[prevOp.name] ? item.completedOperations[prevOp.name].completedQuantity : 0;
                    if (prevComp < item.quantity) { allPrevComplete = false; break; }
                }
                canShow = allPrevComplete;
            }
            if (canShow) {
                const remaining = item.quantity - completedFinishing;
                if (remaining > 0) {
                    has = true;
                    currentAvailableItems.push({ itemIndex: idx, operationName: finishingOp.name, item: item, remaining: remaining, displayName: finishingOp.name, total: item.quantity, completed: completedFinishing, section: item.section, weight: item.weightPerPiece || 0, isBalanceMode: balanceMode });
                }
            }
            return;
        }
        item.operations.forEach((op, opIdx) => {
            if (canMachineDoOperation(machine, op.name, item.section)) {
                const completed = item.completedOperations[op.name] ? item.completedOperations[op.name].completedQuantity : 0;
                const remaining = item.quantity - completed;
                if (remaining > 0) {
                    let prevComplete = true;
                    for (let i = 0; i < opIdx; i++) {
                        const prev = item.operations[i];
                        const prevComp = item.completedOperations[prev.name] ? item.completedOperations[prev.name].completedQuantity : 0;
                        if (prevComp < item.quantity) { prevComplete = false; break; }
                    }
                    if (prevComplete) {
                        has = true;
                        let disp = op.name;
                        if (isSheet && machine === 'Shear') {
                            if (op.name.toLowerCase().includes('crop')) return;
                            if (op.name.toLowerCase().includes('shear') || op.name.toLowerCase().includes('cutting')) disp = "Shearing & Cropping";
                        }
                        currentAvailableItems.push({ itemIndex: idx, operationName: op.name, item, remaining, displayName: disp, total: item.quantity, completed, section: item.section, weight: item.weightPerPiece || 0 });
                    }
                }
            }
        });
    });
    if (has && currentAvailableItems.length) {
        document.getElementById('availableItemsContainer').classList.remove('hidden');
        document.getElementById('remainingQuantityInfo').textContent = `Available items: ${currentAvailableItems.length}`;
        renderAvailableItems(currentAvailableItems);
    } else {
        document.getElementById('availableItemsContainer').classList.add('hidden');
        document.getElementById('itemDetails').classList.add('hidden');
        showToast('No items available for this machine', 'warning');
    }
}

function renderAvailableItems(items) {
    const sel = document.getElementById('availableItemsSelect');
    sel.innerHTML = '<option disabled selected>Select item...</option>';
    items.forEach(data => {
        const opt = document.createElement('option');
        opt.value = data.itemIndex;
        let balanceNote = data.isBalanceMode ? ' [Balance Mode]' : '';
        opt.textContent = `${data.item.itemName} - ${data.item.section} - ${data.displayName} (Remaining: ${data.remaining})${balanceNote}`;
        opt.setAttribute('data-operation', data.operationName);
        opt.setAttribute('data-section', data.section);
        opt.setAttribute('data-total', data.total);
        opt.setAttribute('data-completed', data.completed);
        opt.setAttribute('data-remaining', data.remaining);
        opt.setAttribute('data-weight', data.weight);
        sel.appendChild(opt);
    });
    if (items.length === 1) { sel.selectedIndex = 1; updateQuantityField(); }
}

function filterAvailableItems() {
    const search = document.getElementById('itemSearchInput').value.toLowerCase().trim();
    if (!search) renderAvailableItems(currentAvailableItems);
    else renderAvailableItems(currentAvailableItems.filter(d => d.item.itemName.toLowerCase().includes(search)));
}

function updateQuantityField() {
    const opt = document.getElementById('availableItemsSelect').selectedOptions[0];
    if (opt && opt.value) {
        document.getElementById('selectedItemSection').textContent = opt.getAttribute('data-section');
        document.getElementById('selectedItemOperation').textContent = opt.getAttribute('data-operation');
        document.getElementById('selectedItemTotal').textContent = opt.getAttribute('data-total');
        document.getElementById('selectedItemCompleted').textContent = opt.getAttribute('data-completed');
        document.getElementById('selectedItemRemaining').textContent = opt.getAttribute('data-remaining');
        document.getElementById('selectedItemWeight').textContent = `${opt.getAttribute('data-weight')} kg/piece`;
        document.getElementById('itemDetails').classList.remove('hidden');
        document.getElementById('productionQuantity').max = parseInt(opt.getAttribute('data-remaining'));
        document.getElementById('productionQuantity').min = 1;
        document.getElementById('productionQuantity').value = 1;
    } else document.getElementById('itemDetails').classList.add('hidden');
}

function validateQuantity() {
    const inp = document.getElementById('productionQuantity');
    const opt = document.getElementById('availableItemsSelect').selectedOptions[0];
    const warn = document.getElementById('quantityWarning');
    if (!opt || !opt.value) { warn.classList.add('hidden'); return; }
    const max = parseInt(opt.getAttribute('data-remaining'));
    let val = parseInt(inp.value);
    if (val > max) { warn.textContent = `Entered quantity (${val}) is greater than remaining (${max})`; warn.classList.remove('hidden'); inp.value = max; }
    else if (val < 1) { warn.textContent = "Quantity must be at least 1"; warn.classList.remove('hidden'); inp.value = 1; }
    else warn.classList.add('hidden');
}

function canMachineDoOperation(machine, opName, section) {
    const op = opName.toLowerCase();
    const sect = section.toString().trim().toUpperCase();
    const isSheet = sect.startsWith('P') || sect.startsWith('F');
    if (isSheet) {
        if (machine === 'Shear') return op.includes('shear') || op.includes('cutting') || op.includes('crop');
        if (machine === '83P') return op.includes('minimum') || op.includes('min');
        if (machine === 'CNC Bending') return op.includes('bend');
        if (machine === 'Finishing') return op.includes('finish');
    }
    const isAngle = sect.startsWith('L');
    if (machine === '206' || machine === '20.20' || machine === '10.10') return isAngle && (op.includes('minimum') || op.includes('min'));
    if (machine === 'Cropping') return op.includes('crop') || op.includes('cut');
    if (machine === 'Manual Plasma') return op.includes('crop') || op.includes('cut') || op.includes('plasma');
    if (machine === 'Press') return op.includes('bend');
    if (machine === 'Drill') return op.includes('drill');
    if (machine === 'Chamfering') return op.includes('chamfer');
    if (machine === 'Finishing') return op.includes('finish');
    return false;
}

// ============================================================================
// ✅ v2.4.0 — DAILY PRODUCTION IMPORT FROM EXCEL
// ✅ v2.4.1 — Updated to coordinate with manual entry panel
// ============================================================================

function toggleProductionExcelPanel() {
    const panel = document.getElementById('productionExcelPanel');
    const btn = document.getElementById('productionExcelToggleBtn');
    if (!panel) return;
    const willOpen = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !willOpen);
    if (btn) {
        btn.classList.toggle('btn-warning', !willOpen);
        btn.classList.toggle('btn-outline', willOpen);
    }
    if (willOpen) {
        // ✅ v2.4.1 — close the manual entry panel if it was open
        const entryPanel = document.getElementById('productionEntryPanel');
        if (entryPanel && !entryPanel.classList.contains('hidden')) {
            toggleEntryPanel('production');
        }
    }
    if (!willOpen) {
        const input = document.getElementById('productionExcelFile');
        const fn = document.getElementById('productionExcelFileName');
        if (input) input.value = '';
        if (fn) fn.classList.add('hidden');
        currentProductionExcelData = null;
    }
}

function handleProductionExcelSelect(e) {
    const file = e.target.files[0];
    const fn = document.getElementById('productionExcelFileName');
    if (!file) return;
    if (fn) {
        fn.textContent = `✔ File loaded: ${file.name}`;
        fn.classList.remove('hidden');
    }
    const reader = new FileReader();
    reader.onload = function (ev) {
        try {
            const data = new Uint8Array(ev.target.result);
            const wb = XLSX.read(data, { type: 'array' });
            const ws = wb.Sheets[wb.SheetNames[0]];
            currentProductionExcelData = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
            const rows = Math.max(0, currentProductionExcelData.length - 1);
            showToast(`✅ Excel loaded — ${rows} data row(s) detected`, 'success');
        } catch (err) {
            console.error('Excel read error:', err);
            showToast('فشل قراءة ملف الإكسل: ' + err.message, 'error');
            currentProductionExcelData = null;
        }
    };
    reader.readAsArrayBuffer(file);
}

function downloadProductionExcelTemplate() {
    const today = getLocalDateStr();
    const firstWO = workOrdersDB.find(w => !w.archived && w.items && w.items.length > 0);

    let sampleWO = 'WO-2024-001';
    let sampleItem = 'A1';
    let sampleSection = 'L';
    let sampleOp = 'Minimum';
    let sampleMachine = '206';

    if (firstWO) {
        sampleWO = firstWO.workOrderName;
        const firstItem = firstWO.items[0];
        sampleItem = firstItem.itemName || sampleItem;
        sampleSection = firstItem.section || sampleSection;
        if (firstItem.operations && firstItem.operations[0]) {
            sampleOp = firstItem.operations[0].name || sampleOp;
            const mi = getMachineForOperation(sampleOp, sampleSection);
            sampleMachine = mi.machine;
            if (sampleMachine === "206/20.20/10.10") sampleMachine = "206";
        }
    }

    const template = [
        ['Work Order', 'Item Name', 'Operation', 'Quantity', 'Machine', 'Shift', 'Operator', 'Rejected Qty', 'Date'],
        [sampleWO, sampleItem, sampleOp, 10, sampleMachine, 'First Shift',  'Excel Import', 0, today],
        [sampleWO, sampleItem, sampleOp, 5,  sampleMachine, 'Second Shift', 'Excel Import', 0, today]
    ];

    const ws = XLSX.utils.aoa_to_sheet(template);
    ws['!cols'] = [
        { wch: 18 }, { wch: 14 }, { wch: 16 }, { wch: 10 },
        { wch: 14 }, { wch: 14 }, { wch: 16 }, { wch: 12 }, { wch: 12 }
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Production');
    XLSX.writeFile(wb, `production_template_${today}.xlsx`);
    showToast('✅ Template downloaded — Machine/Shift/Operator are prefilled per operation', 'success');
}

function _findProdColIndex(headerRow, patterns, excludePatterns = []) {
    if (!Array.isArray(headerRow)) return -1;
    return headerRow.findIndex(h => {
        if (h === undefined || h === null) return false;
        const hs = String(h).toLowerCase().trim();
        if (!hs) return false;
        const matched = patterns.some(p => hs.includes(String(p).toLowerCase()));
        if (!matched) return false;
        const excluded = excludePatterns.some(p => hs.includes(String(p).toLowerCase()));
        return !excluded;
    });
}

function _normalizeExcelDate(val) {
    if (val === undefined || val === null || val === '') return null;
    if (val instanceof Date) return getLocalDateStr(val);
    if (typeof val === 'number') {
        const excelEpoch = new Date(1899, 11, 30);
        return getLocalDateStr(new Date(excelEpoch.getTime() + val * 86400000));
    }
    const str = String(val).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.slice(0, 10);
    const d = new Date(str);
    if (!isNaN(d.getTime())) return getLocalDateStr(d);
    return null;
}

async function processProductionExcel() {
    if (!hasPermission('canRecordProduction')) {
        showToast('غير مسموح لك بتسجيل الإنتاج', 'error');
        return;
    }
    if (!currentProductionExcelData || currentProductionExcelData.length < 1) {
        showToast('الرجاء رفع ملف Excel أولاً', 'warning');
        return;
    }

    showLoading('Processing production records...');
    await yieldToUI();

    try {
        const headerRow = (currentProductionExcelData[0] || []).map(c => c === undefined ? '' : c);

        const headerText = headerRow.map(c => String(c || '').toLowerCase()).join(' ');
        const looksLikeHeader =
            headerText.includes('work') || headerText.includes('item') ||
            headerText.includes('operation') || headerText.includes('qty') ||
            headerText.includes('quantity') || headerText.includes('shift') ||
            headerText.includes('machine') || headerText.includes('operator') ||
            headerText.includes('أمر العمل') || headerText.includes('البند') ||
            headerText.includes('العملية') || headerText.includes('الكمية') ||
            headerText.includes('الماكينة') || headerText.includes('الوردية') || headerText.includes('العامل');

        let colMap = {
            wo:        _findProdColIndex(headerRow, ['work order', 'workorder', 'wo', 'أمر العمل']),
            item:      _findProdColIndex(headerRow, ['item', 'part', 'البند']),
            operation: _findProdColIndex(headerRow, ['operation', 'process', 'العملية']),
            quantity:  _findProdColIndex(headerRow, ['quantity', 'qty', 'produced', 'الكمية'], ['reject', 'مرفوض']),
            machine:   _findProdColIndex(headerRow, ['machine', 'ماكينة', 'الماكينة']),
            shift:     _findProdColIndex(headerRow, ['shift', 'الوردية']),
            operator:  _findProdColIndex(headerRow, ['operator', 'worker', 'العامل']),
            rejected:  _findProdColIndex(headerRow, ['reject', 'مرفوض', 'تالف']),
            date:      _findProdColIndex(headerRow, ['date', 'التاريخ']),
        };

        if (colMap.wo < 0) colMap.wo = 0;
        if (colMap.item < 0) colMap.item = 1;
        if (colMap.operation < 0) colMap.operation = 2;
        if (colMap.quantity < 0) colMap.quantity = 3;

        const startRow = looksLikeHeader ? 1 : 0;
        const today = getLocalDateStr();
        const validMachines = ['206', '20.20', '10.10', 'Cropping', 'Manual Plasma',
            'Press', 'Drill', 'Chamfering', 'Shear', '83P', 'CNC Bending', 'Finishing'];

        const results = { success: 0, failed: 0, errors: [] };

        for (let i = startRow; i < currentProductionExcelData.length; i++) {
            const row = currentProductionExcelData[i];
            if (!row || !row.some(c => c !== undefined && c !== null && String(c).trim() !== '')) continue;

            try {
                const woName    = String(row[colMap.wo] || '').trim();
                const itemName  = String(row[colMap.item] || '').trim();
                const operation = String(row[colMap.operation] || '').trim();
                const rawQty    = row[colMap.quantity];
                const quantity  = parseInt(String(rawQty).replace(/[^\d-]/g, '')) || 0;
                const rejectedQty = colMap.rejected >= 0
                    ? (parseInt(String(row[colMap.rejected]).replace(/[^\d-]/g, '')) || 0)
                    : 0;

                const machineFromExcel  = colMap.machine  >= 0 ? String(row[colMap.machine]  || '').trim() : '';
                const shiftFromExcel    = colMap.shift    >= 0 ? String(row[colMap.shift]    || '').trim() : '';
                const operatorFromExcel = colMap.operator >= 0 ? String(row[colMap.operator] || '').trim() : '';
                const date = (colMap.date >= 0 ? _normalizeExcelDate(row[colMap.date]) : null) || today;

                if (!woName || !itemName || !operation || quantity <= 0) {
                    results.failed++;
                    results.errors.push(`Row ${i + 1}: بيانات ناقصة (WO / Item / Operation / Qty)`);
                    continue;
                }
                if (rejectedQty < 0) {
                    results.failed++;
                    results.errors.push(`Row ${i + 1}: كمية المرفوض سالبة`);
                    continue;
                }

                let wo = workOrdersDB.find(w => w.workOrderName === woName);
                if (!wo) wo = workOrdersDB.find(w => String(w.id) === woName);
                if (!wo) {
                    results.failed++;
                    results.errors.push(`Row ${i + 1}: أمر الشغل "${woName}" غير موجود`);
                    continue;
                }
                if (wo.archived) {
                    results.failed++;
                    results.errors.push(`Row ${i + 1}: أمر الشغل "${woName}" مؤرشف`);
                    continue;
                }

                const item = wo.items.find(it => it.itemName === itemName);
                if (!item) {
                    results.failed++;
                    results.errors.push(`Row ${i + 1}: البند "${itemName}" غير موجود في ${woName}`);
                    continue;
                }

                const op = item.operations.find(o => o.name.toLowerCase() === operation.toLowerCase())
                        || item.operations.find(o => o.name.toLowerCase().includes(operation.toLowerCase()));
                if (!op) {
                    results.failed++;
                    results.errors.push(`Row ${i + 1}: العملية "${operation}" غير موجودة في البند "${itemName}"`);
                    continue;
                }

                const completed = (item.completedOperations[op.name] && item.completedOperations[op.name].completedQuantity) || 0;
                const remaining = item.quantity - completed;
                if (remaining <= 0) {
                    results.failed++;
                    results.errors.push(`Row ${i + 1}: العملية "${op.name}" مكتملة بالفعل`);
                    continue;
                }

                const validQty = Math.min(quantity, remaining);
                const capped = validQty < quantity;

                if (rejectedQty > validQty) {
                    results.failed++;
                    results.errors.push(`Row ${i + 1}: المرفوض (${rejectedQty}) أكبر من الكمية (${validQty})`);
                    continue;
                }

                // ✅ Machine: من الإكسل إن وُجدت، وإلا تُشتق من نوع العملية
                let machine;
                if (machineFromExcel) {
                    machine = machineFromExcel;
                } else {
                    const mi = getMachineForOperation(op.name, item.section);
                    machine = mi.machine;
                    if (machine === "206/20.20/10.10") machine = "206";
                }
                if (machineFromExcel && !validMachines.includes(machineFromExcel)) {
                    console.warn(`Row ${i + 1}: ماكينة غير معروفة "${machineFromExcel}" — تم قبولها كما هي`);
                }

                const shift    = shiftFromExcel    || 'First Shift';
                const operator = operatorFromExcel || 'Excel Import';

                const goodQty = validQty - rejectedQty;
                const prodWeight = Math.round((item.weightPerPiece || 0) * goodQty);

                productionDB.push({
                    id: Date.now() + Math.random(),
                    workOrderId: wo.id,
                    workOrderName: wo.workOrderName,
                    projectName: wo.projectName,
                    towerType: wo.type,
                    model: wo.model,
                    shift, machine, operator, date,
                    itemName: item.itemName,
                    itemSection: item.section,
                    operation: op.name,
                    quantity: validQty,
                    rejectedQty,
                    producedWeight: prodWeight,
                    weightPerPiece: item.weightPerPiece || 0,
                    totalItemWeight: item.totalWeight || 0,
                    notes: 'Imported from Excel'
                        + (capped ? ` (capped from ${quantity})` : '')
                        + (!machineFromExcel ? ' [machine auto-derived]' : ''),
                    timestamp: Date.now(),
                    recordedBy: currentUser ? currentUser.username : 'system'
                });

                if (!item.completedOperations[op.name]) {
                    item.completedOperations[op.name] = { completed: false, completedQuantity: 0, totalRequired: item.quantity };
                }
                item.completedOperations[op.name].completedQuantity += validQty;
                if (item.completedOperations[op.name].completedQuantity >= item.quantity) {
                    item.completedOperations[op.name].completed = true;
                }

                item.completedQuantity = recalcItemCompletedQuantity(item);
                recalcItemStatus(item);

                results.success++;
            } catch (rowErr) {
                results.failed++;
                results.errors.push(`Row ${i + 1}: ${rowErr.message}`);
            }
        }

        if (results.success > 0) {
            const woSaveResult = await saveToServer('workOrdersDB', workOrdersDB);
            if (!woSaveResult || !woSaveResult.success) {
                hideLoading();
                showToast('تعذّر حفظ تحديث أوامر الشغل على الخادم.', 'error');
                return;
            }
            await flushNewProductionRecords();
            await updateIdealRatesFromActual();

            updateStats();
            renderProductionList();
            renderWorkOrdersList();
            renderDashboard();
        }

        hideLoading();

        let msg = `✅ Imported ${results.success} record(s)`;
        if (results.failed > 0) msg += ` | ⚠️ Failed: ${results.failed}`;
        showToast(msg, results.success > 0 ? 'success' : 'error');

        if (results.errors.length > 0) {
            console.warn('Production Excel import errors:');
            results.errors.forEach(e => console.warn(e));
            if (results.success === 0) {
                alert('Import failed:\n\n' + results.errors.slice(0, 15).join('\n')
                    + (results.errors.length > 15 ? '\n... (see console)' : ''));
            } else if (results.failed > 0) {
                alert(`تم استيراد ${results.success} سجل بنجاح.\nتعذّر استيراد ${results.failed} سجل:\n\n`
                    + results.errors.slice(0, 10).join('\n'));
            }
        }

        if (results.success > 0) {
            const input = document.getElementById('productionExcelFile');
            const fn = document.getElementById('productionExcelFileName');
            if (input) input.value = '';
            if (fn) fn.classList.add('hidden');
            currentProductionExcelData = null;
        }

    } catch (err) {
        hideLoading();
        console.error('processProductionExcel error:', err);
        showToast('Error processing Excel: ' + err.message, 'error');
    }
}

async function recordProduction() {
    if (!hasPermission('canRecordProduction')) { showToast('غير مسموح لك بتسجيل الإنتاج', 'error'); return; }
    const towerType = document.getElementById('productionTowerType').value;
    const model = document.getElementById('productionModel').value;
    const woId = document.getElementById('productionWorkOrder').value;
    const shift = document.getElementById('productionShift').value;
    const machine = document.getElementById('productionMachine').value;
    const operator = document.getElementById('productionOperatorSelect').value;
    const date = document.getElementById('productionDate').value;
    const quantity = parseInt(document.getElementById('productionQuantity').value);
    const rejectedQty = parseInt(document.getElementById('productionRejectedQty').value) || 0;
    const notes = document.getElementById('productionNotes').value;
    const selectedIdx = document.getElementById('availableItemsSelect').value;
    if (!towerType || !model || !woId || !shift || !machine || !date || !operator) { showToast('Please fill all required fields', 'warning'); return; }
    if (selectedIdx === '') { showToast('Please select item', 'warning'); return; }
    if (rejectedQty > quantity) { showToast('Rejected quantity cannot exceed produced quantity', 'warning'); return; }
    const wo = workOrdersDB.find(w => w.id === parseInt(woId));
    if (!wo) { showToast('Work order not found', 'error'); return; }
    const item = wo.items[parseInt(selectedIdx)];
    const selOpt = document.getElementById('availableItemsSelect').selectedOptions[0];
    const opName = selOpt.getAttribute('data-operation');
    const isSheet = item.section.toString().trim().toUpperCase().startsWith('P') || item.section.toString().trim().toUpperCase().startsWith('F');
    const balanceModeActive = balanceMode && machine === 'Finishing';
    const opIsFinish = getOperationPhase(opName) === 'finish';
    const shouldCompleteOthers = balanceModeActive || opIsFinish;
    let finalOperator = operator;

    if (shouldCompleteOthers) {
        const currentOpIndex = item.operations.findIndex(op => op.name === opName);
        let anyOtherCompleted = false;
        for (let i = 0; i < item.operations.length; i++) {
            if (i === currentOpIndex) continue;
            const otherOp = item.operations[i];
            if (otherOp.name === opName) continue;
            const otherComp = item.completedOperations[otherOp.name] ? item.completedOperations[otherOp.name].completedQuantity : 0;
            if (otherComp < item.quantity) {
                const remainingOther = item.quantity - otherComp;
                if (remainingOther > 0) {
                    const otherMachineInfo = getMachineForOperation(otherOp.name, item.section);
                    let otherMachine = otherMachineInfo.machine;
                    if (otherMachine === "206/20.20/10.10") otherMachine = "206";
                    const otherProdWeight = Math.round(item.weightPerPiece * remainingOther);
                    const otherProdRec = {
                        id: Date.now() + Math.random(),
                        workOrderId: parseInt(woId), workOrderName: wo.workOrderName,
                        projectName: wo.projectName, towerType, model, shift,
                        machine: otherMachine, operator: "Balance", date,
                        itemName: item.itemName, itemSection: item.section, operation: otherOp.name,
                        quantity: remainingOther, rejectedQty: 0, producedWeight: otherProdWeight,
                        weightPerPiece: item.weightPerPiece, totalItemWeight: item.totalWeight,
                        notes: opIsFinish ? "Auto-completed because item marked as Finished" : "Auto-completed by Balance mode",
                        timestamp: Date.now(), recordedBy: currentUser ? currentUser.username : 'system'
                    };
                    productionDB.push(otherProdRec);
                    if (!item.completedOperations[otherOp.name]) item.completedOperations[otherOp.name] = { completed: false, completedQuantity: 0, totalRequired: item.quantity };
                    item.completedOperations[otherOp.name].completedQuantity = item.quantity;
                    item.completedOperations[otherOp.name].completed = true;
                    anyOtherCompleted = true;
                }
            }
        }
        if (anyOtherCompleted) {
            const otherFlush = await flushNewProductionRecords();
            const otherSave = await saveToServer('workOrdersDB', workOrdersDB);
            if (!otherFlush || !otherFlush.success || !otherSave || !otherSave.success) {
                showToast('تعذّر حفظ إكمال العمليات الأخرى تلقائيًا على الخادم.', 'error');
                return;
            }
            const msg = opIsFinish ? 'تم إكمال باقي العمليات تلقائياً' : 'تم إكمال العمليات الأخرى تلقائياً بواسطة Balance';
            showToast(msg, 'info');
        }
    }

    if (isSheet && machine === "Shear") {
        if (!item.completedOperations[opName]) item.completedOperations[opName] = { completed: false, completedQuantity: quantity, totalRequired: item.quantity };
        else { item.completedOperations[opName].completedQuantity += quantity; if (item.completedOperations[opName].completedQuantity >= item.quantity) item.completedOperations[opName].completed = true; }
        const cropOp = item.operations.find(op => op.name.toLowerCase().includes('crop'));
        if (cropOp && cropOp.name !== opName) {
            if (!item.completedOperations[cropOp.name]) item.completedOperations[cropOp.name] = { completed: false, completedQuantity: quantity, totalRequired: item.quantity };
            else { item.completedOperations[cropOp.name].completedQuantity += quantity; if (item.completedOperations[cropOp.name].completedQuantity >= item.quantity) item.completedOperations[cropOp.name].completed = true; }
        }
    } else {
        const already = item.completedOperations[opName] ? item.completedOperations[opName].completedQuantity : 0;
        const remaining = item.quantity - already;
        if (quantity > remaining) { showToast(`Quantity exceeds remaining (${remaining})`, 'warning'); return; }
        if (!item.completedOperations[opName]) item.completedOperations[opName] = { completed: false, completedQuantity: quantity, totalRequired: item.quantity };
        else { item.completedOperations[opName].completedQuantity += quantity; if (item.completedOperations[opName].completedQuantity >= item.quantity) item.completedOperations[opName].completed = true; }
    }

    item.completedQuantity = recalcItemCompletedQuantity(item);
    recalcItemStatus(item);

    const woIndex = workOrdersDB.findIndex(w => w.id === parseInt(woId));
    workOrdersDB[woIndex] = wo;
    const woSaveResult = await saveToServer('workOrdersDB', workOrdersDB);
    if (!woSaveResult || !woSaveResult.success) { showToast('تعذّر حفظ تحديث أمر الشغل على الخادم.', 'error'); return; }
    const goodQuantity = quantity - rejectedQty;
    const prodWeight = Math.round(item.weightPerPiece * goodQuantity);
    const prodRec = {
        id: Date.now(),
        workOrderId: parseInt(woId), workOrderName: wo.workOrderName,
        projectName: wo.projectName, towerType, model, shift, machine,
        operator: finalOperator, date,
        itemName: item.itemName, itemSection: item.section, operation: opName,
        quantity, rejectedQty, producedWeight: prodWeight,
        weightPerPiece: item.weightPerPiece, totalItemWeight: item.totalWeight,
        notes: notes + (balanceModeActive ? " (Balance mode)" : ""),
        timestamp: Date.now(), recordedBy: currentUser ? currentUser.username : 'system'
    };
    productionDB.push(prodRec);
    await flushNewProductionRecords();
    await saveProductionPreferences();
    document.getElementById('availableItemsSelect').innerHTML = '<option disabled selected>Select item...</option>';
    document.getElementById('itemSearchInput').value = '';
    document.getElementById('itemDetails').classList.add('hidden');
    document.getElementById('quantityWarning').classList.add('hidden');
    document.getElementById('productionQuantity').value = 1;
    document.getElementById('productionRejectedQty').value = 0;
    document.getElementById('productionNotes').value = '';
    setTimeout(() => loadAvailableItems(), 100);
    updateStats(); renderProductionList(); renderWorkOrdersList(); renderDashboard();
    await updateIdealRatesFromActual();
    showToast(translations[currentLanguage].productionRecorded || 'Production recorded successfully', 'success');
}

// ====== Downtime ======
function calculateDowntimeDuration() {
    const shift = document.getElementById('downtimeShift').value;
    const startTime = document.getElementById('downtimeStartTime').value;
    const endTime = document.getElementById('downtimeEndTime').value;
    if (!shift || !startTime || !endTime) return;
    let start = new Date(`2000-01-01T${startTime}:00`);
    let end = new Date(`2000-01-01T${endTime}:00`);
    if (end <= start) end.setDate(end.getDate() + 1);
    let durationMinutes = (end - start) / (1000 * 60);
    let breakStart, breakEnd;
    if (shift === 'First Shift') { breakStart = new Date(`2000-01-01T12:00:00`); breakEnd = new Date(`2000-01-01T12:30:00`); }
    else if (shift === 'Second Shift') { breakStart = new Date(`2000-01-01T08:00:00`); breakEnd = new Date(`2000-01-01T08:30:00`); }
    else if (shift === 'Third Shift') { breakStart = new Date(`2000-01-01T04:00:00`); breakEnd = new Date(`2000-01-01T04:30:00`); }
    else { document.getElementById('downtimeDuration').value = Math.round(durationMinutes); return; }
    let breakStartAdj = new Date(`2000-01-01T${breakStart.toTimeString().slice(0, 5)}`);
    let breakEndAdj = new Date(`2000-01-01T${breakEnd.toTimeString().slice(0, 5)}`);
    if (breakEndAdj <= breakStartAdj) breakEndAdj.setDate(breakEndAdj.getDate() + 1);
    const overlapStart = new Date(Math.max(start, breakStartAdj));
    const overlapEnd = new Date(Math.min(end, breakEndAdj));
    if (overlapEnd > overlapStart) {
        const breakMinutes = (overlapEnd - overlapStart) / (1000 * 60);
        durationMinutes -= breakMinutes;
    }
    durationMinutes = Math.max(0, Math.round(durationMinutes));
    document.getElementById('downtimeDuration').value = durationMinutes;
}

function onDowntimeTypeChange() {
    const type = document.getElementById('downtimeType').value;
    const workerGroup = document.getElementById('workerNameGroup');
    const workerInput = document.getElementById('downtimeWorkerName');
    if (!workerGroup || !workerInput) return;
    if (type === 'Worker') {
        workerGroup.classList.remove('hidden');
        workerInput.required = true;
        workerInput.focus();
    } else {
        workerGroup.classList.add('hidden');
        workerInput.required = false;
        workerInput.value = '';
    }
}

async function recordDowntime() {
    if (!hasPermission('canRecordDowntime')) { showToast('غير مسموح لك بتسجيل التوقفات', 'error'); return; }
    const date = document.getElementById('downtimeDate').value;
    const shift = document.getElementById('downtimeShift').value;
    const machine = document.getElementById('downtimeMachine').value;
    const downtimeType = document.getElementById('downtimeType').value;
    const description = document.getElementById('downtimeDescription').value.trim();
    const duration = parseInt(document.getElementById('downtimeDuration').value);
    const startTime = document.getElementById('downtimeStartTime').value;
    const endTime = document.getElementById('downtimeEndTime').value;
    const workerInput = document.getElementById('downtimeWorkerName');
    const workerName = workerInput ? workerInput.value.trim() : '';

    if (!date || !shift || !machine || !downtimeType || !description || !duration || !startTime || !endTime) {
        showToast('Please fill all fields including start and end time', 'warning');
        return;
    }
    if (downtimeType === 'Worker' && !workerName) {
        showToast('Please enter the worker name', 'warning');
        if (workerInput) workerInput.focus();
        return;
    }

    const newRecord = {
        id: Date.now(), date, shift, machine, downtimeType, description,
        durationMinutes: duration, startTime, endTime,
        workerName: (downtimeType === 'Worker') ? workerName : '',
        timestamp: Date.now(), recordedBy: currentUser ? currentUser.username : 'system'
    };
    downtimeDB.push(newRecord);
    await saveToServer('downtimeDB', downtimeDB);
    document.getElementById('downtimeForm').reset();
    document.getElementById('downtimeDate').value = getLocalDateStr();
    if (ENTRY_PANEL_AUTO_CLOSE) closeEntryPanel('downtime');
    const workerGroup = document.getElementById('workerNameGroup');
    if (workerGroup) workerGroup.classList.add('hidden');
    updateStats(); renderDowntimeList(); renderDashboard();
    await updateIdealRatesFromActual();
    showToast('Downtime recorded successfully', 'success');
}

function renderDowntimeList() {
    const container = document.getElementById('downtimeContainer');
    if (!container) return;
    const searchEl = document.getElementById('downtimeSearch');
    const search = searchEl ? searchEl.value.toLowerCase().trim() : '';
    const today = getLocalDateStr();
    let records = downtimeDB.filter(r => getLocalDateStr(new Date(r.timestamp)) === today);
    if (search) {
        records = records.filter(r =>
            (r.machine || '').toLowerCase().includes(search) ||
            (r.downtimeType || '').toLowerCase().includes(search) ||
            (r.description || '').toLowerCase().includes(search) ||
            (r.workerName || '').toLowerCase().includes(search)
        );
    }
    records.sort((a, b) => b.timestamp - a.timestamp);
    if (records.length === 0) { container.innerHTML = '<p class="text-center text-gray-500 col-span-2 py-10">No downtime records entered today.</p>'; return; }
    const canDelete = hasPermission('canDeleteDowntime');
    const typeLabels = {
        'Machine': 'ماكينة (Machine)', 'Material': 'خامة (Material)',
        'Worker': 'عامل (Worker)', 'Panel': 'لوحة (Panel)',
        'Maintenance': 'Maintenance', 'Planning Load': 'Planning Load',
        'Material Issue': 'Material Issue', 'Labor Shortage': 'Labor Shortage', 'Quality': 'Quality'
    };
    container.innerHTML = records.map(r => {
        const typeLabel = typeLabels[r.downtimeType] || r.downtimeType;
        const workerLine = (r.downtimeType === 'Worker' && r.workerName) ? `<p class="text-sm text-blue-700 mt-2"><i class="fa-solid fa-user mr-1"></i> ${esc(r.workerName)}</p>` : '';
        return `<div class="card"><div class="p-4"><div class="flex justify-between items-start"><div><h4 class="font-bold">${esc(r.machine)}</h4><div class="flex gap-2 mt-2 flex-wrap"><span class="badge badge-danger">${esc(typeLabel)}</span><span class="badge badge-success text-xs">${esc(r.date)} - ${esc(r.shift || 'N/A')}</span></div></div><div class="text-right"><span class="block font-bold text-red-600">${r.durationMinutes} min</span><span class="block text-xs text-gray-500">${esc(r.startTime || '')} - ${esc(r.endTime || '')}</span></div></div>${workerLine}<p class="text-sm text-gray-600 mt-3">${esc(r.description)}</p>${canDelete ? `<div class="flex justify-end mt-2"><button onclick="showDeleteDowntimeConfirmation(${r.id})" class="delete-btn text-red-500 hover:text-red-700 text-sm"><i class="fa-solid fa-trash"></i></button></div>` : ''}</div></div>`;
    }).join('');
}

// ====== NCR ======
async function populateNCRItems() {
    const woId = document.getElementById('ncrWorkOrder').value;
    const itemSelect = document.getElementById('ncrItem');
    const itemSearchEl = document.getElementById('ncrItemSearch');
    if (itemSearchEl) itemSearchEl.value = '';
    if (!woId) { itemSelect.innerHTML = '<option value="" disabled selected>Select item...</option>'; return; }
    const wo = workOrdersDB.find(w => w.id == woId);
    if (!wo) return;
    itemSelect.innerHTML = '<option value="" disabled selected>Select item...</option>';
    wo.items.forEach((item, idx) => {
        const option = document.createElement('option');
        option.value = idx;
        option.textContent = `${item.itemName} (${item.section}) - Qty: ${item.quantity}`;
        itemSelect.appendChild(option);
    });
}

function onNCRCauseChange() {
    const cause = document.getElementById('ncrCause').value;
    const workerGroup = document.getElementById('ncrWorkerNameGroup');
    const workerInput = document.getElementById('ncrWorkerName');
    if (!workerGroup || !workerInput) return;
    if (cause === 'Worker') {
        workerGroup.classList.remove('hidden');
        workerInput.required = true;
        workerInput.focus();
    } else {
        workerGroup.classList.add('hidden');
        workerInput.required = false;
        workerInput.value = '';
    }
}

async function recordNCR() {
    if (!hasPermission('canRecordNCR')) { showToast('غير مسموح لك بتسجيل NCR', 'error'); return; }
    const date = document.getElementById('ncrDate').value;
    const shift = document.getElementById('ncrShift').value;
    const machine = document.getElementById('ncrMachine').value;
    const woId = document.getElementById('ncrWorkOrder').value;
    const itemIdx = document.getElementById('ncrItem').value;
    const rejectedQty = parseInt(document.getElementById('ncrRejectedQty').value);
    const ncrType = document.getElementById('ncrType').value;
    const comment = document.getElementById('ncrComment').value;
    const ncrCauseEl = document.getElementById('ncrCause');
    const ncrCause = ncrCauseEl ? ncrCauseEl.value : '';
    const workerInput = document.getElementById('ncrWorkerName');
    const ncrWorkerName = workerInput ? workerInput.value.trim() : '';

    if (!date || !shift || !machine || !woId || itemIdx === '' || !rejectedQty || !ncrType) {
        showToast('Please fill all required fields', 'warning');
        return;
    }
    if (!ncrCause) {
        showToast('Please select NCR Cause', 'warning');
        if (ncrCauseEl) ncrCauseEl.focus();
        return;
    }
    if (ncrCause === 'Worker' && !ncrWorkerName) {
        showToast('Please enter the worker name', 'warning');
        if (workerInput) workerInput.focus();
        return;
    }

    const wo = workOrdersDB.find(w => w.id == woId);
    if (!wo) { showToast('Work order not found', 'error'); return; }
    const item = wo.items[itemIdx];
    if (!item) { showToast('Item not found', 'error'); return; }

    const newNCR = {
        id: Date.now(), date, shift, machine,
        workOrderId: parseInt(woId), workOrderName: wo.workOrderName,
        itemName: item.itemName, rejectedQty, ncrType, comment,
        ncrCause: ncrCause,
        ncrWorkerName: (ncrCause === 'Worker') ? ncrWorkerName : '',
        timestamp: Date.now(), recordedBy: currentUser ? currentUser.username : 'system'
    };
    ncrDB.push(newNCR);
    await saveToServer('ncrDB', ncrDB);

    document.getElementById('ncrForm').reset();
    document.getElementById('ncrDate').value = getLocalDateStr();
    if (ENTRY_PANEL_AUTO_CLOSE) closeEntryPanel('ncr');
    const woSearch = document.getElementById('ncrWorkOrderSearch');
    const itemSearch = document.getElementById('ncrItemSearch');
    if (woSearch) woSearch.value = '';
    if (itemSearch) itemSearch.value = '';
    const workerGroup = document.getElementById('ncrWorkerNameGroup');
    if (workerGroup) workerGroup.classList.add('hidden');
    if (workerInput) { workerInput.value = ''; workerInput.required = false; }

    document.getElementById('ncrWorkOrder').innerHTML = '<option value="" disabled selected>Select work order...</option>';
    document.getElementById('ncrItem').innerHTML = '<option value="" disabled selected>Select item...</option>';
    populateNCRWorkOrders();
    renderNCRList(); renderDashboard(); updateStats();
    showToast('NCR recorded successfully', 'success');
}

function renderNCRList() {
    const container = document.getElementById('ncrContainer');
    if (!container) return;
    const searchEl = document.getElementById('ncrSearch');
    const search = searchEl ? searchEl.value.toLowerCase().trim() : '';
    const now = new Date();
    const curYear = now.getFullYear(), curMonth = now.getMonth();
    let records = ncrDB.filter(r => {
        const d = new Date(r.timestamp);
        return d.getFullYear() === curYear && d.getMonth() === curMonth;
    });
    if (search) {
        records = records.filter(r =>
            (r.itemName || '').toLowerCase().includes(search) ||
            (r.ncrType || '').toLowerCase().includes(search) ||
            (r.ncrCause || '').toLowerCase().includes(search) ||
            (r.ncrWorkerName || '').toLowerCase().includes(search) ||
            (r.comment || '').toLowerCase().includes(search) ||
            (r.workOrderName || '').toLowerCase().includes(search)
        );
    }
    records.sort((a, b) => b.timestamp - a.timestamp);
    if (records.length === 0) { container.innerHTML = '<p class="text-center text-gray-500 col-span-2 py-10">No NCR records this month.</p>'; return; }
    const canDelete = hasPermission('canDeleteNCR');

    const causeLabels = {
        'Worker': 'عامل (Worker)',
        'Machine': 'ماكينة (Machine)',
        'Drawing': 'الرسم الهندسي (Workshop Drawing)',
        'Material': 'خامة (Material)'
    };
    const causeColors = {
        'Worker': 'bg-blue-100 text-blue-800',
        'Machine': 'bg-red-100 text-red-800',
        'Drawing': 'bg-purple-100 text-purple-800',
        'Material': 'bg-yellow-100 text-yellow-800'
    };

    container.innerHTML = records.map(r => {
        const causeLabel = r.ncrCause ? (causeLabels[r.ncrCause] || r.ncrCause) : null;
        const causeClass = r.ncrCause ? (causeColors[r.ncrCause] || 'bg-gray-100 text-gray-800') : 'bg-gray-100 text-gray-800';
        const causeLine = causeLabel
            ? `<span class="px-2 py-1 text-xs rounded-full ${causeClass} font-bold">${causeLabel}</span>`
            : '';
        const workerLine = (r.ncrCause === 'Worker' && r.ncrWorkerName)
            ? `<p class="text-sm text-blue-700 mt-2"><i class="fa-solid fa-user mr-1"></i> ${esc(r.ncrWorkerName)}</p>`
            : '';

        return `<div class="card"><div class="p-4"><div class="flex justify-between items-start"><div><h4 class="font-bold">${esc(r.itemName)}</h4><div class="flex gap-2 mt-2 flex-wrap"><span class="badge badge-danger">${esc(r.ncrType)}</span>${causeLine}<span class="badge badge-success text-xs">${esc(r.date)} - ${esc(r.shift)}</span></div><p class="text-xs text-gray-500 mt-2"><i class="fa-solid fa-file-contract mr-1"></i> ${esc(r.workOrderName)}</p></div><div class="text-right"><span class="block font-bold text-red-600">${r.rejectedQty} pcs</span><span class="block text-xs text-gray-500">${esc(r.machine)}</span></div></div>${workerLine}${r.comment ? `<p class="text-sm text-gray-600 mt-3">${esc(r.comment)}</p>` : ''}${canDelete ? `<div class="flex justify-end mt-2"><button onclick="showDeleteNCRConfirmation(${r.id})" class="delete-btn text-red-500 hover:text-red-700 text-sm"><i class="fa-solid fa-trash"></i></button></div>` : ''}</div></div>`;
    }).join('');
}

// ====== HR Functions ======
async function saveEmployee() {
    if (!hasPermission('canManageEmployees')) { showToast('غير مسموح لك بإدارة الموظفين', 'error'); return; }
    const empId = document.getElementById('empId').value.trim();
    const name = document.getElementById('empName').value.trim();
    if (!empId || !name) { showToast('Employee ID and Name are required', 'warning'); return; }
    const existingIndex = employeesDB.findIndex(e => e.id === empId);
    const employee = {
        id: empId, name: name,
        department: document.getElementById('empDept').value,
        position: document.getElementById('empPosition').value,
        shift: document.getElementById('empShift').value,
        phone: document.getElementById('empPhone').value,
        hireDate: document.getElementById('empHireDate').value,
        status: document.getElementById('empStatus').value,
        updatedAt: Date.now()
    };
    if (existingIndex >= 0) { employeesDB[existingIndex] = { ...employeesDB[existingIndex], ...employee }; showToast('Employee updated successfully', 'success'); }
    else { employeesDB.push(employee); showToast('Employee added successfully', 'success'); }
    await saveToServer('employeesDB', employeesDB);
    renderEmployeesList(); resetEmployeeForm(); updateEmployeesStats();
}

function resetEmployeeForm() {
    document.getElementById('empId').value = '';
    document.getElementById('empName').value = '';
    document.getElementById('empDept').value = 'Production';
    document.getElementById('empPosition').value = 'Operator';
    document.getElementById('empShift').value = 'First Shift';
    document.getElementById('empPhone').value = '';
    document.getElementById('empHireDate').value = '';
    document.getElementById('empStatus').value = 'Active';
    document.getElementById('editEmpId').value = '';
}

function editEmployee(empId) {
    if (!hasPermission('canManageEmployees')) { showToast('غير مسموح لك بتعديل الموظفين', 'error'); return; }
    const emp = employeesDB.find(e => e.id === empId);
    if (!emp) return;
    document.getElementById('empId').value = emp.id;
    document.getElementById('empName').value = emp.name;
    document.getElementById('empDept').value = emp.department || 'Production';
    document.getElementById('empPosition').value = emp.position || 'Operator';
    document.getElementById('empShift').value = emp.shift || 'First Shift';
    document.getElementById('empPhone').value = emp.phone || '';
    document.getElementById('empHireDate').value = emp.hireDate || '';
    document.getElementById('empStatus').value = emp.status || 'Active';
    document.getElementById('editEmpId').value = emp.id;
    document.getElementById('hrSection').scrollIntoView({ behavior: 'smooth' });
}

async function deleteEmployee(empId) {
    if (!hasPermission('canManageEmployees')) { showToast('غير مسموح لك بحذف الموظفين', 'error'); return; }
    const idx = employeesDB.findIndex(e => e.id === empId);
    if (idx === -1) return;
    employeesDB.splice(idx, 1);
    await saveToServer('employeesDB', employeesDB);
    renderEmployeesList(); updateEmployeesStats();
    showToast(translations[currentLanguage].employeeDeleted || 'Employee deleted successfully', 'success');
}

function showDeleteEmployeeConfirmation(empId) {
    if (!hasPermission('canManageEmployees')) return;
    const emp = employeesDB.find(e => e.id === empId);
    if (!emp) return;
    const t = translations[currentLanguage];
    showConfirmationDialog(t.deleteRecord, `${t.areYouSureDeleteEmployee}<br><br><strong>${emp.name}</strong><br>ID: ${emp.id}`, deleteEmployee, empId);
}

function renderEmployeesList() {
    const container = document.getElementById('employeesContainer');
    if (!container) return;
    const searchEl = document.getElementById('employeeSearch');
    const search = searchEl ? searchEl.value.toLowerCase().trim() : '';
    let list = employeesDB.slice();
    if (search) list = list.filter(e => (e.name || '').toLowerCase().includes(search) || (e.id || '').toLowerCase().includes(search));
    list.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    if (list.length === 0) { container.innerHTML = '<p class="text-center text-gray-500 col-span-2 py-10">No employees. Add your first employee.</p>'; return; }
    const canManage = hasPermission('canManageEmployees');
    container.innerHTML = list.map(e => {
        const idJs = esc(JSON.stringify(e.id));
        const statusClass = e.status === 'Active' ? 'badge-success' : (e.status === 'On Leave' ? 'badge-warning' : 'badge-secondary');
        return `<div class="card"><div class="p-4 flex items-center gap-4"><div class="bg-indigo-100 p-3 rounded-full"><i class="fa-solid fa-user text-indigo-600 text-xl"></i></div><div class="flex-1"><h4 class="font-bold">${esc(e.name)}</h4><div class="flex gap-2 mt-2 flex-wrap"><span class="badge badge-primary">${esc(e.id)}</span><span class="badge badge-info">${esc(e.department || '-')}</span><span class="badge ${statusClass}">${esc(e.status || 'Active')}</span></div><p class="text-xs text-gray-500 mt-2">${esc(e.position || '-')} · ${esc(e.shift || '-')}${e.phone ? ' · ' + esc(e.phone) : ''}</p></div>${canManage ? `<div class="flex flex-col gap-2"><button onclick="editEmployee(${idJs})" class="text-blue-500 hover:text-blue-700 text-sm"><i class="fa-solid fa-pen"></i></button><button onclick="showDeleteEmployeeConfirmation(${idJs})" class="delete-btn text-red-500 hover:text-red-700 text-sm"><i class="fa-solid fa-trash"></i></button></div>` : ''}</div></div>`;
    }).join('');
}

function updateEmployeesStats() {
    const totalEl = document.getElementById('totalEmployees');
    const activeEl = document.getElementById('activeEmployees');
    if (totalEl) totalEl.textContent = employeesDB.length;
    if (activeEl) activeEl.textContent = employeesDB.filter(e => e.status === 'Active').length;
}

// ====== Operators ======
function updateOperatorsDropdown() {
    const machine = document.getElementById('productionMachine').value;
    const sel = document.getElementById('productionOperatorSelect');
    if (!machine) { sel.innerHTML = '<option disabled selected>Select machine first...</option>'; return; }
    const ops = machineOperatorsDB[machine] || [];
    sel.innerHTML = '<option disabled selected>Select operator...</option>';
    ops.forEach(op => { const opt = document.createElement('option'); opt.value = op; opt.textContent = op; sel.appendChild(opt); });
    if (productionPreferences.operator && ops.includes(productionPreferences.operator)) sel.value = productionPreferences.operator;
}

function showOperatorsManagement() {
    if (!hasPermission('canManageOperators')) { showToast('غير مسموح لك بإدارة العاملين', 'error'); return; }
    const modal = document.createElement('div');
    modal.className = 'modal active';
    modal.innerHTML = `<div class="modal-content" style="max-width:600px"><div class="modal-header"><h3 class="text-lg font-bold"><i class="fa-solid fa-users mr-2"></i> Machine Operators Management</h3><button onclick="this.closest('.modal').remove()" class="btn btn-outline btn-sm"><i class="fa-solid fa-times"></i></button></div><div class="modal-body"><div class="space-y-4"><div class="input-group"><label class="input-label">Select Machine</label><select id="operatorMachineSelect" class="input-field" onchange="loadOperatorsForMachine()"><option value="" disabled selected>Select machine...</option><option value="206">206</option><option value="20.20">20.20</option><option value="10.10">10.10</option><option value="Cropping">Cropping</option><option value="Manual Plasma">Manual Plasma</option><option value="Press">Press</option><option value="Drill">Drill</option><option value="Chamfering">Chamfering</option><option value="Finishing">Finishing</option><option value="Shear">Shear</option><option value="83P">83P</option><option value="CNC Bending">CNC Bending</option></select></div><div id="operatorsListContainer" class="hidden"><div class="flex justify-between items-center mb-2"><label class="input-label">Operators</label><button onclick="addOperatorField()" class="btn btn-primary btn-sm"><i class="fa-solid fa-plus"></i> Add</button></div><div id="operatorsList" class="space-y-2"></div><button onclick="saveOperators()" class="btn btn-secondary w-full mt-4">Save Operators</button></div></div></div></div>`;
    document.body.appendChild(modal);
}

function loadOperatorsForMachine() {
    const machine = document.getElementById('operatorMachineSelect').value;
    const container = document.getElementById('operatorsListContainer');
    const list = document.getElementById('operatorsList');
    if (!machine) { container.classList.add('hidden'); return; }
    container.classList.remove('hidden');
    list.innerHTML = '';
    const ops = machineOperatorsDB[machine] || [];
    ops.forEach(op => { list.innerHTML += `<div class="flex gap-2 items-center"><input type="text" value="${op}" class="input-field flex-1 operator-name"><button onclick="removeOperator(this)" class="btn btn-danger btn-sm"><i class="fa-solid fa-trash"></i></button></div>`; });
    if (ops.length === 0) addOperatorField();
}

function addOperatorField() {
    const list = document.getElementById('operatorsList');
    list.innerHTML += `<div class="flex gap-2 items-center"><input type="text" class="input-field flex-1 operator-name" placeholder="Operator name"><button onclick="removeOperator(this)" class="btn btn-danger btn-sm"><i class="fa-solid fa-trash"></i></button></div>`;
}

function removeOperator(btn) { btn.parentElement.remove(); }

async function saveOperators() {
    const machine = document.getElementById('operatorMachineSelect').value;
    const inputs = document.querySelectorAll('.operator-name');
    const operators = Array.from(inputs).map(i => i.value.trim()).filter(v => v);
    machineOperatorsDB[machine] = operators;
    await saveToServer('machineOperatorsDB', machineOperatorsDB);
    showToast(translations[currentLanguage].operatorsSaved, 'success');
    updateOperatorsDropdown();
    const modal = document.querySelector('.modal.active');
    if (modal) modal.remove();
}

// ====== Production Preferences ======
async function saveProductionPreferences() {
    productionPreferences = {
        towerType: document.getElementById('productionTowerType').value,
        model: document.getElementById('productionModel').value,
        workOrderId: document.getElementById('productionWorkOrder').value,
        shift: document.getElementById('productionShift').value,
        machine: document.getElementById('productionMachine').value,
        operator: document.getElementById('productionOperatorSelect').value,
        date: document.getElementById('productionDate').value
    };
    await saveToServer('productionPreferences', productionPreferences);
    showToast(translations[currentLanguage].preferencesSaved, 'success');
}

function loadProductionPreferences() {
    if (!productionPreferences) return;
    if (productionPreferences.towerType) {
        document.getElementById('productionTowerType').value = productionPreferences.towerType;
        populateProductionModelDropdown();
        setTimeout(() => {
            if (productionPreferences.model) {
                document.getElementById('productionModel').value = productionPreferences.model;
                populateWorkOrderDropdown();
                setTimeout(() => {
                    if (productionPreferences.workOrderId) {
                        document.getElementById('productionWorkOrder').value = productionPreferences.workOrderId;
                        populateProjectDropdown();
                    }
                }, 300);
            }
        }, 300);
    }
    if (productionPreferences.shift) document.getElementById('productionShift').value = productionPreferences.shift;
    if (productionPreferences.machine) {
        document.getElementById('productionMachine').value = productionPreferences.machine;
        updateOperatorsDropdown();
        const balanceContainer = document.getElementById('balanceToggleContainer');
        if (balanceContainer) {
            if (productionPreferences.machine === 'Finishing') {
                balanceContainer.classList.remove('hidden');
                const toggle = document.getElementById('balanceToggle');
                if (toggle) { toggle.checked = false; balanceMode = false; }
            } else {
                balanceContainer.classList.add('hidden');
                const toggle = document.getElementById('balanceToggle');
                if (toggle && toggle.checked) { toggle.checked = false; balanceMode = false; }
            }
        }
        setTimeout(() => { if (productionPreferences.workOrderId && productionPreferences.machine) loadAvailableItems(); }, 500);
    }
    const dateField = document.getElementById('productionDate');
    if (productionPreferences.date) dateField.value = productionPreferences.date;
    else dateField.value = getYesterdayDateStr();
}

async function clearProductionForm() {
    if (confirm('Clear all fields?')) {
        document.getElementById('productionForm').reset();
        document.getElementById('productionDate').value = getYesterdayDateStr();
        document.getElementById('productionProject').innerHTML = '<option disabled selected>Will be filled automatically...</option>';
        document.getElementById('productionOperatorSelect').innerHTML = '<option disabled selected>Select operator...</option>';
        document.getElementById('availableItemsContainer').classList.add('hidden');
        document.getElementById('availableItemsSelect').innerHTML = '<option disabled selected>Select item...</option>';
        document.getElementById('itemDetails').classList.add('hidden');
        productionPreferences = { towerType: '', model: '', workOrderId: '', shift: '', machine: '', operator: '', date: new Date().toISOString().split('T')[0] };
        await saveToServer('productionPreferences', productionPreferences);
        populateProductionTowerTypeDropdown();
        showToast(translations[currentLanguage].fieldsCleared, 'success');
    }
}

// ====== OEE/TEEP ======
function calculateActualIdealRates() {
    const shiftMinutes = 480;
    const prodMap = new Map();
    productionDB.forEach(rec => {
        const key = `${rec.machine}_${rec.shift}_${rec.date}`;
        if (!prodMap.has(key)) prodMap.set(key, { quantity: 0, machine: rec.machine, shift: rec.shift, date: rec.date });
        prodMap.get(key).quantity += rec.quantity;
    });
    const downtimeMap = new Map();
    downtimeDB.forEach(rec => {
        const key = `${rec.machine}_${rec.shift}_${rec.date}`;
        if (!downtimeMap.has(key)) downtimeMap.set(key, { minutes: 0 });
        downtimeMap.get(key).minutes += rec.durationMinutes;
    });
    const machineRates = {};
    for (let [key, prod] of prodMap.entries()) {
        const downtime = downtimeMap.get(key) || { minutes: 0 };
        const operatingMinutes = Math.max(0, shiftMinutes - downtime.minutes);
        if (operatingMinutes <= 0) continue;
        const operatingHours = operatingMinutes / 60;
        const rate = prod.quantity / operatingHours;
        if (rate > 0 && rate < 10000) {
            if (!machineRates[prod.machine]) machineRates[prod.machine] = [];
            machineRates[prod.machine].push(rate);
        }
    }
    const avgRates = {};
    for (let [machine, ratesArray] of Object.entries(machineRates)) {
        if (ratesArray.length > 0) {
            const sum = ratesArray.reduce((a, b) => a + b, 0);
            avgRates[machine] = Math.round(sum / ratesArray.length);
        }
    }
    return avgRates;
}

async function updateIdealRatesFromActual() {
    const calculated = calculateActualIdealRates();
    const manual = JSON.parse(localStorage.getItem('manualIdealRates')) || {};
    let updated = false;
    for (let [machine, rate] of Object.entries(calculated)) {
        if (!manual[machine]) {
            if (machineIdealRates[machine] !== rate) { machineIdealRates[machine] = rate; updated = true; }
        }
    }
    if (updated) {
        await saveToServer('machineIdealRates', machineIdealRates);
        showToast(`Ideal rates updated from actual production data`, 'info');
        renderDashboard();
    }
}

function showIdealRatesManagement() {
    if (!hasPermission('canViewReports')) { showToast('غير مسموح لك بعرض إعدادات السرعات المثالية', 'error'); return; }
    const modal = document.createElement('div');
    modal.className = 'modal active';
    const machines = ['206', '20.20', '10.10', 'Cropping', 'Manual Plasma', 'Press', 'Drill', 'Chamfering', 'Shear', '83P', 'CNC Bending', 'Finishing'];
    const calculatedRates = calculateActualIdealRates();
    let html = `<div class="modal-content" style="max-width:700px"><div class="modal-header"><h3 class="text-lg font-bold"><i class="fa-solid fa-gauge-high mr-2"></i> ${translations[currentLanguage].manageIdealRates}</h3><button onclick="this.closest('.modal').remove()" class="btn btn-outline btn-sm"><i class="fa-solid fa-times"></i></button></div><div class="modal-body"><div class="mb-4 p-3 bg-blue-50 rounded-lg text-sm"><i class="fa-solid fa-info-circle mr-2"></i> The rates below are calculated automatically from actual production records. </div><div class="space-y-3" id="idealRatesList">`;
    machines.forEach(m => {
        const currentRate = machineIdealRates[m] || '';
        const calculatedRate = calculatedRates[m] || 'N/A';
        const displayCalc = calculatedRate !== 'N/A' ? `${calculatedRate} pcs/hr` : 'No data';
        html += `<div class="input-group"><label class="input-label">${m}</label><input type="number" id="idealRate_${m.replace(/ /g, '_')}" class="input-field" value="${currentRate}" placeholder="${translations[currentLanguage].idealRate}" step="1" min="0"><div class="text-xs text-gray-500 mt-1">Calculated average: ${displayCalc}</div></div>`;
    });
    html += `<div class="flex gap-2 mt-4"><button onclick="updateIdealRatesFromActualAndCloseModal()" class="btn btn-secondary flex-1"><i class="fa-solid fa-calculator"></i> Calculate from Actual Data</button><button onclick="saveIdealRates()" class="btn btn-primary flex-1"><i class="fa-solid fa-save"></i> ${translations[currentLanguage].saveIdealRates}</button></div></div></div></div>`;
    modal.innerHTML = html;
    document.body.appendChild(modal);
}

async function updateIdealRatesFromActualAndCloseModal() {
    const calculated = calculateActualIdealRates();
    const manual = JSON.parse(localStorage.getItem('manualIdealRates')) || {};
    for (let [machine, rate] of Object.entries(calculated)) {
        machineIdealRates[machine] = rate;
        delete manual[machine];
    }
    localStorage.setItem('manualIdealRates', JSON.stringify(manual));
    await saveToServer('machineIdealRates', machineIdealRates);
    showToast('Ideal rates updated from actual data', 'success');
    const modal = document.querySelector('.modal.active');
    if (modal) modal.remove();
    renderDashboard();
}

async function saveIdealRates() {
    const machines = ['206', '20.20', '10.10', 'Cropping', 'Manual Plasma', 'Press', 'Drill', 'Chamfering', 'Shear', '83P', 'CNC Bending', 'Finishing'];
    const manualOverrides = {};
    const calculated = calculateActualIdealRates();
    machines.forEach(m => {
        const input = document.getElementById(`idealRate_${m.replace(/ /g, '_')}`);
        if (input) {
            const val = parseInt(input.value);
            if (!isNaN(val) && val > 0) {
                machineIdealRates[m] = val;
                if (calculated[m] && val !== calculated[m]) manualOverrides[m] = val;
                else if (!calculated[m] && val > 0) manualOverrides[m] = val;
            } else {
                delete machineIdealRates[m];
                delete manualOverrides[m];
            }
        }
    });
    localStorage.setItem('manualIdealRates', JSON.stringify(manualOverrides));
    await saveToServer('machineIdealRates', machineIdealRates);
    showToast('Ideal rates saved successfully', 'success');
    const modal = document.querySelector('.modal.active');
    if (modal) modal.remove();
    renderDashboard();
}

function calculateOEEAndTEEPForMachine(machine, startDate, endDate) {
    const plannedMinutesPerShift = 480;
    const calendarMinutesPerDay = 1440;
    let totalPlannedMinutes = 0, totalOperatingMinutes = 0, totalCalendarMinutes = 0;
    let totalGoodPieces = 0, totalIdealPieces = 0;
    const prodRecords = productionDB.filter(r => r.machine === machine && r.date >= startDate && r.date <= endDate);
    if (prodRecords.length === 0) return null;
    const shiftMap = new Map();
    prodRecords.forEach(rec => {
        const key = `${rec.date}_${rec.shift}`;
        if (!shiftMap.has(key)) shiftMap.set(key, { date: rec.date, shift: rec.shift, produced: 0, rejected: 0 });
        const data = shiftMap.get(key);
        data.produced += rec.quantity;
        data.rejected += rec.rejectedQty || 0;
    });
    const ncrRecords = ncrDB.filter(r => r.machine === machine && r.date >= startDate && r.date <= endDate);
    ncrRecords.forEach(ncr => {
        const key = `${ncr.date}_${ncr.shift}`;
        if (shiftMap.has(key)) shiftMap.get(key).rejected += ncr.rejectedQty;
        else shiftMap.set(key, { date: ncr.date, shift: ncr.shift, produced: 0, rejected: ncr.rejectedQty });
    });
    const downtimeRecords = downtimeDB.filter(r => r.machine === machine && r.date >= startDate && r.date <= endDate);
    const uniqueDates = new Set();
    shiftMap.forEach((data) => { uniqueDates.add(data.date); });
    totalCalendarMinutes = uniqueDates.size * calendarMinutesPerDay;
    for (let [key, data] of shiftMap.entries()) {
        totalPlannedMinutes += plannedMinutesPerShift;
        let downtimeForShift = 0;
        downtimeRecords.forEach(dt => {
            if (dt.date === data.date && dt.shift === data.shift) downtimeForShift += dt.durationMinutes;
        });
        let operatingMinutes = Math.max(0, plannedMinutesPerShift - downtimeForShift);
        totalOperatingMinutes += operatingMinutes;
        const goodPieces = data.produced - data.rejected;
        totalGoodPieces += goodPieces;
        const idealRate = machineIdealRates[machine] || 0;
        if (idealRate > 0) {
            const idealPiecesThisShift = (operatingMinutes / 60) * idealRate;
            totalIdealPieces += idealPiecesThisShift;
        }
    }
    if (totalPlannedMinutes === 0 || totalIdealPieces === 0) return null;
    const availability = totalOperatingMinutes / totalPlannedMinutes;
    const performance = totalGoodPieces / totalIdealPieces;
    const totalProduced = prodRecords.reduce((sum, r) => sum + r.quantity, 0);
    const totalRejectedFromProd = prodRecords.reduce((sum, r) => sum + (r.rejectedQty || 0), 0);
    const totalRejectedFromNCR = ncrRecords.reduce((sum, n) => sum + n.rejectedQty, 0);
    const totalRejected = totalRejectedFromProd + totalRejectedFromNCR;
    const quality = totalProduced > 0 ? (totalProduced - totalRejected) / totalProduced : 0;
    const oee = availability * performance * quality;
    let teep = 0, utilization = 0;
    if (totalCalendarMinutes > 0) {
        utilization = totalPlannedMinutes / totalCalendarMinutes;
        teep = oee * utilization;
    }
    return { availability, performance, quality, oee, teep, utilization, totalPlannedMinutes, totalOperatingMinutes, totalCalendarMinutes, totalGoodPieces, totalIdealPieces, totalProduced, totalRejected };
}

// ====== Reports Generation ======
function selectReportType(type) {
    const user = getCurrentUser();
    if (!user || !hasPermission('canViewReports')) { showToast('غير مسموح لك بعرض التقارير', 'error'); return; }
    if (type === 'ncrReport' && user.role !== ROLES.QC && user.role !== ROLES.PRODUCTION && user.role !== ROLES.ADMINISTRATOR) {
        showToast('هذا التقرير مخصص لإدارة الجودة أو الإنتاج', 'warning');
        return;
    }
    const container = document.getElementById('reportFormsContainer');
    if (!container) return;
    const summaryStrip = document.getElementById('reportSummaryStrip');
    if (summaryStrip) summaryStrip.innerHTML = '';
    let html = '';
    switch (type) {
        case 'salesOrderTree':
            html = `<div class="card p-4">
                <h3 class="text-lg font-bold mb-4"><i class="fa-solid fa-sitemap mr-2 text-emerald-600"></i> ${soTreeT('soFamilyTree', 'Sales Order Family Tree')}</h3>
                <p class="text-sm text-gray-500 mb-3">${soTreeT('soFamilyTreeDesc', 'Hierarchical tree for each Sales Order with its Work Orders, status and delay alerts')}</p>
                <div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                    <div class="input-group">
                        <label class="input-label">${soTreeT('treeSalesOrderFilter', 'Sales Order')}</label>
                        <select id="treeSalesOrderFilter" class="input-field" onchange="generateSalesOrderTree()">
                            <option value="">${soTreeT('allSalesOrders', 'All Sales Orders')}</option>
                        </select>
                    </div>
                    <div class="input-group">
                        <label class="input-label">${soTreeT('treeStatusFilter', 'Status')}</label>
                        <select id="treeStatusFilter" class="input-field" onchange="generateSalesOrderTree()">
                            <option value="all">${soTreeT('treeStatusAll', 'All')}</option>
                            <option value="inprogress">${soTreeT('treeStatusInProgress', 'In Progress Only')}</option>
                            <option value="finished">${soTreeT('treeStatusFinished', 'Finished Only')}</option>
                            <option value="delayed">${soTreeT('treeStatusDelayed', 'Delayed Only')}</option>
                        </select>
                    </div>
                    <div class="input-group">
                        <label class="input-label">${soTreeT('treeViewStyle', 'View Style')}</label>
                        <select id="treeViewStyle" class="input-field" onchange="generateSalesOrderTree()">
                            <option value="detail">${soTreeT('treeDetailView', 'Detailed Tree (collapsible)')}</option>
                            <option value="summary">${soTreeT('treeSummaryView', 'Summary (one row per Sales Order)')}</option>
                        </select>
                    </div>
                    <div class="input-group">
                        <label class="input-label">${soTreeT('treeDelayDays', 'Delay Threshold (days)')}</label>
                        <input type="number" id="treeDelayDays" class="input-field" min="1" step="1" value="30" onchange="generateSalesOrderTree()">
                    </div>
                    <div class="input-group">
                        <label class="input-label">${soTreeT('treeDelayBasis', 'Delay Basis')}</label>
                        <select id="treeDelayBasis" class="input-field" onchange="generateSalesOrderTree()">
                            <option value="age">${soTreeT('treeBasisAge', 'Days since work order creation')}</option>
                            <option value="idle">${soTreeT('treeBasisIdle', 'Days without production activity')}</option>
                        </select>
                    </div>
                </div>
                <button onclick="generateSalesOrderTree()" class="btn btn-primary mt-2">
                    <i class="fa-solid fa-sitemap"></i> ${soTreeT('generateFamilyTree', 'Generate Family Tree')}
                </button>
            </div>`;
            break;
        case 'itemsStatus':
            html = `<div class="card p-4"><h3 class="text-lg font-bold mb-4">${translations[currentLanguage].itemsStatusReport || 'Items Status Report'}</h3><p class="text-sm text-gray-500 mb-3">${translations[currentLanguage].detailedStatus || 'Get detailed status of items'}</p><div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4"><div class="input-group"><label class="input-label">${translations[currentLanguage].selectWorkOrder || 'Select Work Order'}</label><select id="reportWorkOrder" class="input-field"></select></div><div class="input-group"><label class="input-label">Search Work Order Number</label><input type="text" id="reportWorkOrderSearch" class="input-field" placeholder="Type work order name or project..." oninput="filterWorkOrderSelect()"></div></div><button onclick="generateItemsStatusReport()" class="btn btn-primary mt-4">${translations[currentLanguage].generateItemsStatus || 'Generate Items Status Report'}</button></div>`;
            break;
        case 'detailedItem':
            html = `<div class="card p-4"><h3 class="text-lg font-bold mb-4">Detailed Item Report</h3><div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4"><div class="input-group"><label class="input-label">Select Work Order</label><select id="detailReportWorkOrder" class="input-field" onchange="populateItemsForReport()"></select></div><div class="input-group"><label class="input-label">Search Work Order</label><input type="text" id="detailReportWorkOrderSearch" class="input-field" placeholder="Type work order name or project..." oninput="filterDetailWorkOrderSelect()"></div></div><div id="itemSelectionContainer" class="hidden"><div class="input-group mt-4"><label class="input-label">Search Item</label><input type="text" id="detailItemSearchInput" class="input-field" onkeyup="filterItemsForReport()" placeholder="Search item..."></div><div class="input-group"><label class="input-label">Select Item</label><select id="detailReportItem" class="input-field"></select></div></div><button onclick="generateDetailedItemReport()" class="btn btn-primary mt-4">Generate Report</button></div>`;
            break;
        case 'dailyProduction':
            html = `<div class="card p-4"><h3 class="text-lg font-bold mb-4">Daily Production Report</h3><div class="grid grid-cols-2 gap-4"><div class="input-group"><label class="input-label" data-i18n="fromDate">From Date</label><input type="date" id="dailyReportFromDate" class="input-field"></div><div class="input-group"><label class="input-label" data-i18n="toDate">To Date</label><input type="date" id="dailyReportToDate" class="input-field"></div></div><div class="grid grid-cols-2 gap-4"><div class="input-group"><label class="input-label">Operation Phase</label><select id="dailyReportPhase" class="input-field" onchange="updateDailyReportMachines()"><option value="">All Phases</option><option value="minimum">Minimum</option><option value="crop">Cropping</option><option value="shear">Shearing</option><option value="bend">Bending</option><option value="drill">Drilling</option><option value="chamfer">Chamfering</option><option value="finish">Finishing</option></select></div><div class="input-group"><label class="input-label">Shift</label><select id="dailyReportShift" class="input-field"><option value="">All Shifts</option><option value="First Shift">First Shift</option><option value="Second Shift">Second Shift</option><option value="Third Shift">Third Shift</option></select></div></div><div class="grid grid-cols-2 gap-4"><div class="input-group"><label class="input-label">Machine Name</label><select id="dailyReportMachine" class="input-field"><option value="">All Machines</option></select></div><div class="input-group"><label class="input-label">Work Order</label><select id="dailyReportWorkOrder" class="input-field"><option value="">All Work Orders</option></select></div></div><button onclick="generateDailyProductionReport()" class="btn btn-primary mt-4">Generate Report</button></div>`;
            break;
        case 'operationStatus':
            html = `<div class="card p-4"><h3 class="text-lg font-bold mb-4">Operation Status Report</h3><div class="input-group"><label class="input-label">Sales Order</label><select id="operationSalesOrder" class="input-field" onchange="populateWorkOrdersForOperation()"><option value="">All Sales Orders</option></select></div><div class="input-group"><label class="input-label">Operation Phase</label><select id="operationPhase" class="input-field" onchange="populateWorkOrdersForOperation()"><option value="">All Phases</option><option value="minimum">Minimum</option><option value="crop">Cropping</option><option value="shear">Shearing</option><option value="bend">Bending</option><option value="drill">Drilling</option><option value="chamfer">Chamfering</option><option value="finish">Finishing</option></select></div><div class="input-group"><label class="input-label">Work Order</label><select id="operationWorkOrder" class="input-field"><option value="">All Work Orders</option></select></div><div class="input-group"><label class="input-label">Status Filter</label><select id="operationStatusFilter" class="input-field"><option value="All">All</option><option value="Done">Done</option><option value="In Progress">In Progress</option><option value="Ready">Ready</option><option value="Pending">Pending</option></select></div><div id="machineCategoryContainer"><div class="input-group"><label class="input-label">Machine Category</label><select id="operationMachineCategory" class="input-field"><option value="all">All</option><option value="angles">Angles</option><option value="plates">Plates</option></select></div></div><button onclick="generateOperationStatusReport()" class="btn btn-primary mt-4">Generate Report</button></div>`;
            break;
        case 'shortage':
            html = `<div class="card p-4"><h3 class="text-lg font-bold mb-4">Shortage Report</h3><div class="input-group"><label class="input-label">Select Work Order</label><select id="shortageWorkOrder" class="input-field"><option value="">All Work Orders</option></select></div><button onclick="generateShortageReport()" class="btn btn-primary mt-4">Generate Report</button></div>`;
            break;
        case 'downtime':
            html = `<div class="card p-4"><h3 class="text-lg font-bold mb-4">Downtime Report</h3><div class="grid grid-cols-2 gap-4"><div class="input-group"><label class="input-label">From Date</label><input type="date" id="downtimeReportFromDate" class="input-field"></div><div class="input-group"><label class="input-label">To Date</label><input type="date" id="downtimeReportToDate" class="input-field"></div></div><div class="grid grid-cols-2 gap-4"><div class="input-group"><label class="input-label">Phase</label><select id="downtimeReportPhase" class="input-field"><option value="">All Phases</option><option value="minimum">Minimum</option><option value="cropping">Cropping</option><option value="shearing">Shearing</option><option value="bending">Bending</option><option value="chamfering">Chamfering</option></select></div><div class="input-group"><label class="input-label">Fault Type</label><select id="downtimeReportType" class="input-field"><option value="">All Types</option><option value="Machine">ماكينة - Machine</option><option value="Material">خامة - Material</option><option value="Worker">عامل - Worker</option><option value="Panel">لوحة - Panel</option></select></div></div><button onclick="generateDowntimeReport()" class="btn btn-primary mt-4">Generate Report</button></div>`;
            break;
        case 'ncrReport':
            html = `<div class="card p-4"><h3 class="text-lg font-bold mb-4">NCR Report</h3><div class="grid grid-cols-2 gap-4"><div class="input-group"><label class="input-label">From Date</label><input type="date" id="ncrReportFromDate" class="input-field"></div><div class="input-group"><label class="input-label">To Date</label><input type="date" id="ncrReportToDate" class="input-field"></div></div><div class="grid grid-cols-2 gap-4"><div class="input-group"><label class="input-label">Machine</label><select id="ncrReportMachine" class="input-field"><option value="">All Machines</option><option value="206">206</option><option value="20.20">20.20</option><option value="10.10">10.10</option><option value="Cropping">Cropping</option><option value="Manual Plasma">Manual Plasma</option><option value="Press">Press</option><option value="Drill">Drill</option><option value="Chamfering">Chamfering</option><option value="Shear">Shear</option><option value="83P">83P</option><option value="CNC Bending">CNC Bending</option><option value="Finishing">Finishing</option></select></div><div class="input-group"><label class="input-label">NCR Type</label><select id="ncrReportType" class="input-field"><option value="">All Types</option><option value="Scrap">Scrap</option><option value="Accept as it is">Accept as it is</option><option value="Repair">Repair</option></select></div></div><button onclick="generateNCRReport()" class="btn btn-primary mt-4">Generate Report</button></div>`;
            break;
        case 'oeeReport':
            html = `<div class="card p-4"><h3 class="text-lg font-bold mb-4">OEE Report</h3><div class="grid grid-cols-2 gap-4"><div class="input-group"><label class="input-label">From Date</label><input type="date" id="oeeReportFromDate" class="input-field"></div><div class="input-group"><label class="input-label">To Date</label><input type="date" id="oeeReportToDate" class="input-field"></div></div><div class="input-group"><label class="input-label">Machine</label><select id="oeeReportMachine" class="input-field"><option value="">All Machines</option><option value="206">206</option><option value="20.20">20.20</option><option value="10.10">10.10</option><option value="Cropping">Cropping</option><option value="Manual Plasma">Manual Plasma</option><option value="Press">Press</option><option value="Drill">Drill</option><option value="Chamfering">Chamfering</option><option value="Shear">Shear</option><option value="83P">83P</option><option value="CNC Bending">CNC Bending</option><option value="Finishing">Finishing</option></select></div><button onclick="generateOEEReport()" class="btn btn-primary mt-4">Generate Report</button></div>`;
            break;
        case 'teepReport':
            html = `<div class="card p-4"><h3 class="text-lg font-bold mb-4">TEEP Report</h3><div class="grid grid-cols-2 gap-4"><div class="input-group"><label class="input-label">From Date</label><input type="date" id="teepReportFromDate" class="input-field"></div><div class="input-group"><label class="input-label">To Date</label><input type="date" id="teepReportToDate" class="input-field"></div></div><div class="input-group"><label class="input-label">Machine</label><select id="teepReportMachine" class="input-field"><option value="">All Machines</option><option value="206">206</option><option value="20.20">20.20</option><option value="10.10">10.10</option><option value="Cropping">Cropping</option><option value="Manual Plasma">Manual Plasma</option><option value="Press">Press</option><option value="Drill">Drill</option><option value="Chamfering">Chamfering</option><option value="Shear">Shear</option><option value="83P">83P</option><option value="CNC Bending">CNC Bending</option><option value="Finishing">Finishing</option></select></div><button onclick="generateTEEPReport()" class="btn btn-primary mt-4">Generate Report</button></div>`;
            break;
        case 'projectStageSummary':
            html = `<div class="card p-4"><h3 class="text-lg font-bold mb-4">${(translations[currentLanguage].stageSummaryReport) || 'Project Stage Summary'}</h3><div class="input-group"><label class="input-label">${(translations[currentLanguage].selectSalesOrder) || 'Select Sales Order'}</label><select id="stageSummarySO" class="input-field" onchange="generateProjectStageSummary()"><option value="">${(translations[currentLanguage].allSalesOrders) || 'All Sales Orders'}</option></select></div><button onclick="generateProjectStageSummary()" class="btn btn-primary mt-4"><i class="fa-solid fa-layer-group mr-2"></i>${(translations[currentLanguage].generateStageSummary) || 'Generate Stage Summary'}</button></div>`;
            break;
        case 'minimumStoppage':
            html = `<div class="card p-4"><h3 class="text-lg font-bold mb-4">${(translations[currentLanguage].minStoppageReport) || 'Stopped After Minimum'}</h3><p class="text-sm text-gray-500 mb-3">${(translations[currentLanguage].minStoppageDesc) || 'Items that completed Minimum'}</p><div class="input-group"><label class="input-label">${(translations[currentLanguage].selectSalesOrder) || 'Select Sales Order'}</label><select id="minStopSO" class="input-field" onchange="generateMinimumStoppageReport()"><option value="">${(translations[currentLanguage].allSalesOrders) || 'All Sales Orders'}</option></select></div><div class="input-group"><label class="input-label">Category</label><select id="minStopCategory" class="input-field" onchange="generateMinimumStoppageReport()"><option value="all">All</option><option value="angles">Angles</option><option value="plates">Plates</option></select></div><button onclick="generateMinimumStoppageReport()" class="btn btn-primary mt-4"><i class="fa-solid fa-circle-stop mr-2"></i>${(translations[currentLanguage].generateReport) || 'Generate Report'}</button></div>`;
            break;
        case 'monthlyProduction':
            html = `<div class="card p-4"><h3 class="text-lg font-bold mb-4">${translations[currentLanguage].monthlyProductionReport || 'Monthly Production Report'}</h3><p class="text-sm text-gray-500 mb-4">${translations[currentLanguage].monthlyReportDesc || 'Daily Minimum & Finish vs target'}</p><div class="flex items-center gap-4"><label class="text-sm font-medium">${translations[currentLanguage].month || 'Month'}:</label><input type="month" id="monthlyReportMonth" class="input-field w-48" value="${new Date().toISOString().slice(0, 7)}" /><button onclick="generateMonthlyProductionReport()" class="btn btn-primary"><i class="fa-solid fa-file-alt"></i> ${translations[currentLanguage].generateMonthlyReport || 'Generate Monthly Report'}</button></div></div>`;
            break;
        default: return;
    }
    container.innerHTML = html;
    container.classList.remove('hidden');
    if (type === 'salesOrderTree') {
        const soSel = document.getElementById('treeSalesOrderFilter');
        if (soSel) {
            const sos = getDistinctSalesOrders();
            soSel.innerHTML = `<option value="">${soTreeT('allSalesOrders', 'All Sales Orders')}</option>`;
            sos.forEach(so => { soSel.innerHTML += `<option value="${esc(so)}">${esc(so)}</option>`; });
        }
        const treeSaved = soTreeLoadSettings();
        const treeDaysEl = document.getElementById('treeDelayDays');
        const treeBasisEl = document.getElementById('treeDelayBasis');
        if (treeDaysEl) treeDaysEl.value = treeSaved.days;
        if (treeBasisEl) treeBasisEl.value = treeSaved.basis;
        soTreeState.search = '';
        soTreeState.sort = 'so';
        generateSalesOrderTree();
    }
    if (type === 'ncrReport') { document.getElementById('ncrReportFromDate').value = getLocalDateStr(); document.getElementById('ncrReportToDate').value = getLocalDateStr(); }
    if (type === 'oeeReport') { document.getElementById('oeeReportFromDate').value = getLocalDateStr(); document.getElementById('oeeReportToDate').value = getLocalDateStr(); }
    if (type === 'teepReport') { document.getElementById('teepReportFromDate').value = getLocalDateStr(); document.getElementById('teepReportToDate').value = getLocalDateStr(); }
    if (type === 'itemsStatus' || type === 'detailedItem') {
        populateReportDropdowns();
        if (type === 'itemsStatus') { const s = document.getElementById('reportWorkOrderSearch'); if (s) s.value = ''; }
        else { const s = document.getElementById('detailReportWorkOrderSearch'); if (s) s.value = ''; }
    }
    if (type === 'dailyProduction') {
        populateDailyReportWorkOrders();
        populateMachinesDropdown();
        document.getElementById('dailyReportFromDate').value = getLocalDateStr();
        document.getElementById('dailyReportToDate').value = getLocalDateStr();
    }
    if (type === 'operationStatus') { fillSalesOrderSelect('operationSalesOrder'); populateWorkOrdersForOperation(); }
    if (type === 'projectStageSummary') { populateStageSummarySalesOrders(); generateProjectStageSummary(); }
    if (type === 'minimumStoppage') { fillSalesOrderSelect('minStopSO'); generateMinimumStoppageReport(); }
    if (type === 'shortage') populateShortageWorkOrders();
    if (type === 'downtime') { document.getElementById('downtimeReportFromDate').value = getLocalDateStr(); document.getElementById('downtimeReportToDate').value = getLocalDateStr(); }
}

function populateMachinesDropdown(phase) {
    const sel = document.getElementById('dailyReportMachine');
    if (!sel) return;
    let machines = getMachinesByPhase(phase);
    sel.innerHTML = '<option value="">' + (translations[currentLanguage].allMachines || 'All Machines') + '</option>';
    machines.forEach(m => { sel.innerHTML += `<option value="${m}">${m}</option>`; });
}

function updateDailyReportMachines() {
    const phaseSelect = document.getElementById('dailyReportPhase');
    const phase = phaseSelect ? phaseSelect.value : '';
    populateMachinesDropdown(phase);
}

function populateItemsForReport() {
    const woId = document.getElementById('detailReportWorkOrder').value;
    const container = document.getElementById('itemSelectionContainer');
    if (!woId) { if (container) container.classList.add('hidden'); return; }
    const wo = workOrdersDB.find(w => w.id === parseInt(woId));
    if (!wo) return;
    allItemsForReport = wo.items.map((it, idx) => ({ index: idx, item: it }));
    allItemsForReportFiltered = [...allItemsForReport];
    renderItemsForReport(allItemsForReportFiltered);
    if (container) container.classList.remove('hidden');
}

function renderItemsForReport(items) {
    const sel = document.getElementById('detailReportItem');
    if (!sel) return;
    sel.innerHTML = '<option disabled selected>Select item...</option>';
    items.forEach(d => { sel.innerHTML += `<option value="${d.index}">${d.item.itemName} - ${d.item.section} (${d.item.status}) - Qty: ${d.item.completedQuantity || 0}/${d.item.quantity}</option>`; });
}

function filterItemsForReport() {
    const search = document.getElementById('detailItemSearchInput').value.toLowerCase().trim();
    if (!search) allItemsForReportFiltered = [...allItemsForReport];
    else allItemsForReportFiltered = allItemsForReport.filter(d => d.item.itemName.toLowerCase().includes(search));
    renderItemsForReport(allItemsForReportFiltered);
}

// ====== Generate Reports ======
async function generateItemsStatusReport() {
    if (!hasPermission('canViewReports')) { showToast('غير مسموح لك بعرض التقارير', 'error'); return; }
    const woValue = document.getElementById('reportWorkOrder') ? document.getElementById('reportWorkOrder').value : null;
    let selectedWOs = [];
    if (!woValue || woValue === 'all') selectedWOs = workOrdersDB;
    else { const wo = workOrdersDB.find(w => w.id === parseInt(woValue)); if (wo) selectedWOs = [wo]; }
    if (selectedWOs.length === 0) { showToast('No work orders found', 'warning'); return; }
    showLoading(translations[currentLanguage].processing || 'Processing...');
    await yieldToUI();
    try {
        const completionMap = new Map();
        for (const rec of productionDB) {
            const key = `${rec.workOrderId}_${rec.itemName}_${rec.operation}`;
            const existing = completionMap.get(key);
            if (!existing || rec.date > existing) completionMap.set(key, rec.date);
        }
        let titleSuffix = (!woValue || woValue === 'all') ? 'All Work Orders' : selectedWOs[0].workOrderName;
        document.getElementById('reportTitle').textContent = `Items Status Report - ${titleSuffix}`;
        const header = document.getElementById('reportTableHeader');
        const body = document.getElementById('reportTableBody');
        header.innerHTML = `<tr><th>#</th><th>Item Name</th><th>Section</th><th>Steel Grade</th><th>Project Name</th><th>Sales Order #</th><th>Quantity</th><th>Completed</th><th>Remaining</th><th>Status</th><th>Operations</th><th>Completion Dates</th></tr>`;
        const rows = [];
        let globalIndex = 0;
        for (const wo of selectedWOs) {
            wo.items.forEach((item) => {
                let opsHtml = '', datesHtml = '';
                item.operations.forEach(op => {
                    const comp = item.completedOperations[op.name];
                    const compQty = comp ? comp.completedQuantity : 0;
                    const isComp = compQty >= item.quantity;
                    opsHtml += `<div class="text-xs p-1 rounded ${isComp ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-700'} mb-1">${op.name} (${compQty}/${item.quantity})${isComp ? ' <i class="fa-solid fa-check text-green-600 ml-1"></i>' : ''}</div>`;
                    let completionDate = '-';
                    if (isComp) {
                        const key = `${wo.id}_${item.itemName}_${op.name}`;
                        const dateRecorded = completionMap.get(key);
                        if (dateRecorded) completionDate = dateRecorded;
                    }
                    datesHtml += `<div class="text-xs p-1 mb-1">${completionDate}</div>`;
                });
                const statusClass = item.status === 'Completed' ? 'status-completed' : (item.status === 'In Progress' ? 'status-in-progress' : 'status-pending');
                globalIndex++;
                rows.push(`<tr><td class="text-center">${globalIndex}</td><td class="font-bold">${item.itemName}</td><td>${item.section}</td><td class="text-center">${item.steelGrade || '-'}</td><td class="text-center">${wo.projectName}</td><td class="text-center">${wo.salesOrderNumber}</td><td class="text-center">${item.quantity}</td><td class="text-center">${item.completedQuantity || 0}</td><td class="text-center">${item.quantity - (item.completedQuantity || 0)}</td><td class="text-center"><span class="status-indicator ${statusClass}">${item.status}</span></td><td class="text-center">${opsHtml}</td><td class="text-center">${datesHtml}</td></tr>`);
            });
        }
        body.innerHTML = rows.join('');
        document.getElementById('reportResults').classList.remove('hidden');
        document.getElementById('reportResults').scrollIntoView({ behavior: 'smooth' });
        showToast('Items status report generated', 'success');
    } catch (err) { console.error(err); showToast('Error generating report', 'error'); }
    finally { hideLoading(); }
}

async function generateDetailedItemReport() {
    if (!hasPermission('canViewReports')) { showToast('غير مسموح لك بعرض التقارير', 'error'); return; }
    const woId = document.getElementById('detailReportWorkOrder') ? document.getElementById('detailReportWorkOrder').value : null;
    const itemIdx = document.getElementById('detailReportItem') ? document.getElementById('detailReportItem').value : null;
    if (!woId || itemIdx === '') { showToast('Please select work order and item', 'warning'); return; }
    const wo = workOrdersDB.find(w => w.id === parseInt(woId));
    if (!wo || !wo.items[itemIdx]) { showToast('Item not found', 'error'); return; }
    const item = wo.items[itemIdx];
    document.getElementById('reportTitle').textContent = `Detailed Item Report - ${item.itemName} (${item.section || '-'}, Length: ${item.length || '-'}) | WO: ${wo.workOrderName} | SO: ${wo.salesOrderNumber}`;
    const header = document.getElementById('reportTableHeader');
    const body = document.getElementById('reportTableBody');
    header.innerHTML = `<tr><th>#</th><th>Operation</th><th>Machine</th><th>Required</th><th>Completed</th><th>Remaining</th><th>Status</th><th>Production Records</th></tr>`;
    const prodRecords = productionDB.filter(r => r.workOrderId === parseInt(woId) && r.itemName === item.itemName);
    const recordsByOp = new Map();
    for (const r of prodRecords) {
        if (!recordsByOp.has(r.operation)) recordsByOp.set(r.operation, []);
        recordsByOp.get(r.operation).push(r);
    }
    const rows = [];
    item.operations.forEach((op, idx) => {
        const comp = item.completedOperations[op.name];
        const compQty = comp ? comp.completedQuantity : 0;
        const isComp = compQty >= item.quantity;
        const opRecords = recordsByOp.get(op.name) || [];
        let recHtml = '';
        opRecords.forEach(rec => { recHtml += `<div class="text-xs p-1 bg-gray-50 rounded mb-1"><div class="font-bold">${rec.date} - ${rec.shift}</div><div>Machine: ${rec.machine} | Operator: ${rec.operator}</div><div>Quantity: ${rec.quantity} | Weight: ${rec.producedWeight || 0} kg</div></div>`; });
        if (!recHtml) recHtml = '<div class="text-xs text-gray-500 p-1">No production records</div>';
        const statusClass = isComp ? 'status-completed' : (compQty > 0 ? 'status-in-progress' : 'status-pending');
        const statusText = isComp ? 'Completed' : (compQty > 0 ? 'In Progress' : 'Pending');
        rows.push(`<tr><td class="text-center">${idx + 1}</td><td class="font-bold">${op.name}</td><td class="text-center">${op.machine}</td><td class="text-center">${item.quantity}</td><td class="text-center">${compQty}</td><td class="text-center">${item.quantity - compQty}</td><td class="text-center"><span class="status-indicator ${statusClass}">${statusText}</span></td><td class="text-center">${recHtml}</td></tr>`);
    });
    rows.push(`<tr class="summary-row"><td class="text-center"></td><td class="font-bold text-center">Item Summary</td><td class="text-center">—</td><td class="font-bold text-center">${item.quantity}</td><td class="font-bold text-center">${item.completedQuantity || 0}</td><td class="font-bold text-center">${item.quantity - (item.completedQuantity || 0)}</td><td class="font-bold text-center">${item.status}</td><td class="font-bold text-center">Total Production Records: ${prodRecords.length}</td></tr>`);
    body.innerHTML = rows.join('');
    document.getElementById('reportResults').classList.remove('hidden');
    document.getElementById('reportResults').scrollIntoView({ behavior: 'smooth' });
    showToast('Detailed item report generated', 'success');
}

function generateDailyProductionReport() {
    if (!hasPermission('canViewReports')) { showToast('غير مسموح لك بعرض التقارير', 'error'); return; }
    const from = document.getElementById('dailyReportFromDate').value;
    const to = document.getElementById('dailyReportToDate').value;
    const shift = document.getElementById('dailyReportShift').value;
    const phase = document.getElementById('dailyReportPhase')?.value || '';
    const machine = document.getElementById('dailyReportMachine').value;
    const woId = document.getElementById('dailyReportWorkOrder').value;
    if (!from || !to) { showToast('Please select date range', 'warning'); return; }
    showLoading(translations[currentLanguage].processing || 'Processing...');
    setTimeout(() => {
        try {
            const fromDate = new Date(from), toDate = new Date(to);
            const woIdInt = woId ? parseInt(woId) : null;
            let filtered = productionDB.filter(r => {
                const d = new Date(r.date);
                if (d < fromDate || d > toDate) return false;
                if (shift && r.shift !== shift) return false;
                if (machine && r.machine !== machine) return false;
                if (woIdInt && r.workOrderId !== woIdInt) return false;
                if (phase && getOperationPhase(r.operation) !== phase) return false;
                const user = getCurrentUser();
                if (user && (user.role === ROLES.PRODUCTION || user.role === ROLES.ADMINISTRATOR)) {
                    if (r.recordedBy && r.recordedBy !== user.username) return false;
                }
                return true;
            });
            filtered.sort((a, b) => new Date(b.date) - new Date(a.date) || b.timestamp - a.timestamp);
            document.getElementById('reportTitle').textContent = 'Daily Production Report (' + from + ' to ' + to + ')';
            const header = document.getElementById('reportTableHeader');
            const body = document.getElementById('reportTableBody');
            header.innerHTML = '<tr><th>#</th><th>Date</th><th>Shift</th><th>Work Order</th><th>Item Name</th><th>Section</th><th>Operation</th><th>Machine</th><th>Operator</th><th>Quantity</th><th>Weight Produced</th></tr>';
            let html = '';
            if (filtered.length === 0) html = '<tr><td colspan="11" class="text-center py-4">No production records found</td></tr>';
            else {
                let totalQty = 0, totalWt = 0;
                for (let i = 0; i < filtered.length; i++) {
                    const r = filtered[i];
                    totalQty += r.quantity;
                    const weight = parseFloat(r.producedWeight) || 0;
                    totalWt += weight;
                    html += '<tr><td class="text-center">' + (i + 1) + '</td><td class="text-center">' + r.date + '</td><td class="text-center">' + r.shift + '</td><td class="text-center">' + r.workOrderName + '</td><td class="font-bold">' + r.itemName + '</td><td class="text-center">' + (r.itemSection || '-') + '</td><td class="text-center">' + r.operation + '</td><td class="text-center">' + r.machine + '</td><td class="text-center">' + (r.operator || '-') + '</td><td class="font-bold text-purple-700">' + r.quantity + '</td><td class="font-bold text-green-700">' + weight + ' kg</td></tr>';
                }
                html += '<tr class="total-row"><td colspan="9" class="font-bold text-right">Totals:</td><td class="font-bold text-purple-700">' + totalQty + '</td><td class="font-bold text-green-700">' + totalWt.toFixed(2) + ' kg</td></tr>';
            }
            body.innerHTML = html;
            document.getElementById('reportResults').classList.remove('hidden');
            document.getElementById('reportResults').scrollIntoView({ behavior: 'smooth' });
            showToast('Daily production report generated', 'success');
        } catch (err) { console.error(err); showToast('Error generating report', 'error'); }
        finally { hideLoading(); }
    }, 50);
}

async function generateOperationStatusReport() {
    if (!hasPermission('canViewReports')) { showToast('غير مسموح لك بعرض التقارير', 'error'); return; }
    const phase = document.getElementById('operationPhase').value;
    const woId = document.getElementById('operationWorkOrder').value;
    const statusFilter = document.getElementById('operationStatusFilter').value;
    const machineCat = document.getElementById('operationMachineCategory') ? document.getElementById('operationMachineCategory').value : 'all';
    const salesOrder = document.getElementById('operationSalesOrder')?.value || '';
    let title = 'Operation Status Report';
    if (phase) title += `- ${phase.charAt(0).toUpperCase() + phase.slice(1)} Phase`;
    if (salesOrder) title += ` (SO: ${salesOrder})`;
    document.getElementById('reportTitle').textContent = title;
    const header = document.getElementById('reportTableHeader');
    const body = document.getElementById('reportTableBody');
    header.innerHTML = `<tr><th>#</th><th>Work Order</th><th>Sales Order</th><th>Project</th><th>Item Name</th><th>Section</th><th>Operation</th><th>Machine</th><th>Required</th><th>Weight (kg)</th><th>Completed</th><th>Remaining</th><th>Status</th></tr>`;
    showLoading(translations[currentLanguage].processing || 'Processing...');
    await yieldToUI();
    try {
        let items = [];
        let totalReq = 0, totalWt = 0, totalComp = 0, totalRem = 0;
        const woIdInt = woId ? parseInt(woId) : null;
        workOrdersDB.forEach(wo => {
            if (woIdInt && wo.id !== woIdInt) return;
            if (salesOrder && wo.salesOrderNumber !== salesOrder) return;
            wo.items.forEach(it => {
                let prevOk = true;
                it.operations.forEach(op => {
                    const comp = it.completedOperations[op.name];
                    const compQty = comp ? comp.completedQuantity : 0;
                    const isComp = compQty >= it.quantity;
                    const phaseMatch = !phase || getOperationPhase(op.name) === phase;
                    let catMatch = true;
                    if (machineCat === 'angles') { const section = it.section.toString().trim().toUpperCase(); if (!section.startsWith('L')) catMatch = false; }
                    else if (machineCat === 'plates') { const section = it.section.toString().trim().toUpperCase(); if (!(section.startsWith('P') || section.startsWith('F'))) catMatch = false; }
                    if (phaseMatch && catMatch) {
                        let status = isComp ? 'Done' : (compQty > 0 ? 'In Progress' : (prevOk ? 'Ready' : 'Pending'));
                        if (statusFilter === 'All' || status === statusFilter) {
                            const weight = it.totalWeight || (it.weightPerPiece * it.quantity) || 0;
                            items.push({ woName: wo.workOrderName, salesOrder: wo.salesOrderNumber, proj: wo.projectName, itemName: it.itemName, section: it.section, opName: op.name, machine: op.machine, required: it.quantity, weight: weight, completed: compQty, remaining: it.quantity - compQty, status: status });
                            totalReq += it.quantity; totalWt += weight; totalComp += compQty; totalRem += (it.quantity - compQty);
                        }
                    }
                    if (!isComp) prevOk = false;
                });
            });
        });
        if (items.length === 0) body.innerHTML = '<tr><td colspan="13" class="text-center py-4">No items found</td></tr>';
        else {
            const order = { 'Done': 1, 'In Progress': 2, 'Ready': 3, 'Pending': 4 };
            items.sort((a, b) => order[a.status] - order[b.status] || a.woName.localeCompare(b.woName));
            const rows = [];
            items.forEach((it, idx) => {
                let cls = '';
                if (it.status === 'Done') cls = 'status-completed';
                else if (it.status === 'In Progress') cls = 'status-in-progress';
                else if (it.status === 'Ready') cls = 'badge badge-info';
                else cls = 'status-pending';
                rows.push(`<tr><td class="text-center">${idx + 1}</td><td class="text-center">${it.woName}</td><td class="text-center">${it.salesOrder}</td><td class="text-center">${it.proj}</td><td class="font-bold">${it.itemName}</td><td class="text-center">${it.section}</td><td class="text-center">${it.opName}</td><td class="text-center">${it.machine}</td><td class="text-center">${it.required}</td><td class="text-center">${it.weight.toFixed(2)}</td><td class="text-center">${it.completed}</td><td class="text-center">${it.remaining}</td><td class="text-center"><span class="${cls}">${it.status}</span></td></tr>`);
            });
            rows.push(`<tr class="total-row"><td colspan="8" class="font-bold text-right">Totals:</td><td class="font-bold">${totalReq}</td><td class="font-bold">${totalWt.toFixed(2)} kg</td><td class="font-bold">${totalComp}</td><td class="font-bold">${totalRem}</td><td class="font-bold"></td></tr>`);
            body.innerHTML = rows.join('');
        }
        document.getElementById('reportResults').classList.remove('hidden');
        document.getElementById('reportResults').scrollIntoView({ behavior: 'smooth' });
        showToast('Operation status report generated', 'success');
    } catch (err) { console.error(err); showToast('Error generating report', 'error'); }
    finally { hideLoading(); }
}

function generateShortageReport() {
    if (!hasPermission('canViewReports')) { showToast('غير مسموح لك بعرض التقارير', 'error'); return; }
    const woId = document.getElementById('shortageWorkOrder').value;
    const selectedId = woId ? parseInt(woId) : null;
    let shortages = [];
    workOrdersDB.forEach(wo => {
        if (selectedId && wo.id !== selectedId) return;
        wo.items.forEach(it => {
            const remaining = it.quantity - (it.completedQuantity || 0);
            if (remaining > 0) shortages.push({ woName: wo.workOrderName, proj: wo.projectName, itemName: it.itemName, section: it.section, quantity: it.quantity, completed: it.completedQuantity || 0, remaining, status: it.status });
        });
    });
    shortages.sort((a, b) => a.woName.localeCompare(b.woName) || a.itemName.localeCompare(b.itemName));
    document.getElementById('reportTitle').textContent = 'Shortage Report';
    const header = document.getElementById('reportTableHeader');
    const body = document.getElementById('reportTableBody');
    header.innerHTML = `<tr><th>#</th><th>Work Order</th><th>Project</th><th>Item Name</th><th>Section</th><th>Total Qty</th><th>Completed</th><th>Remaining</th><th>Status</th></tr>`;
    if (shortages.length === 0) body.innerHTML = '<tr><td colspan="9" class="text-center py-4">No shortage items found</td></tr>';
    else {
        const rows = [];
        shortages.forEach((s, idx) => {
            const cls = s.status === 'Completed' ? 'status-completed' : (s.status === 'In Progress' ? 'status-in-progress' : 'status-pending');
            rows.push(`<tr><td class="text-center">${idx + 1}</td><td class="text-center">${s.woName}</td><td class="text-center">${s.proj}</td><td class="font-bold">${s.itemName}</td><td class="text-center">${s.section}</td><td class="text-center">${s.quantity}</td><td class="text-center">${s.completed}</td><td class="font-bold text-red-600">${s.remaining}</td><td class="text-center"><span class="status-indicator ${cls}">${s.status}</span></td></tr>`);
        });
        body.innerHTML = rows.join('');
    }
    document.getElementById('reportResults').classList.remove('hidden');
    document.getElementById('reportResults').scrollIntoView({ behavior: 'smooth' });
}

function generateDowntimeReport() {
    if (!hasPermission('canViewReports')) { showToast('غير مسموح لك بعرض التقارير', 'error'); return; }
    const from = document.getElementById('downtimeReportFromDate').value;
    const to = document.getElementById('downtimeReportToDate').value;
    const phase = document.getElementById('downtimeReportPhase').value;
    const type = document.getElementById('downtimeReportType').value;
    if (!from || !to) { showToast('Please select date range', 'warning'); return; }
    const fromDate = new Date(from), toDate = new Date(to);
    let filtered = downtimeDB.filter(r => {
        const d = new Date(r.date);
        if (d < fromDate || d > toDate) return false;
        if (phase && getMachinePhase(r.machine) !== phase) return false;
        if (type && r.downtimeType !== type) return false;
        return true;
    });
    filtered.sort((a, b) => new Date(b.date) - new Date(a.date));
    document.getElementById('reportTitle').textContent = `Downtime Report (${from} to ${to})`;
    const header = document.getElementById('reportTableHeader');
    const body = document.getElementById('reportTableBody');
    header.innerHTML = `<tr><th>#</th><th>Date</th><th>Shift</th><th>Machine</th><th>Fault Type</th><th>Worker Name</th><th>Description</th><th>Duration (min)</th></tr>`;
    if (filtered.length === 0) body.innerHTML = '<tr><td colspan="8" class="text-center py-4">No downtime records found</td></tr>';
    else {
        let totalDur = 0;
        const rows = [];
        const typeLabels = { 'Machine': 'ماكينة (Machine)', 'Material': 'خامة (Material)', 'Worker': 'عامل (Worker)', 'Panel': 'لوحة (Panel)' };
        filtered.forEach((r, idx) => {
            totalDur += r.durationMinutes;
            const worker = (r.downtimeType === 'Worker' && r.workerName) ? esc(r.workerName) : '-';
            const typeLabel = typeLabels[r.downtimeType] || r.downtimeType;
            rows.push(`<tr><td class="text-center">${idx + 1}</td><td class="text-center">${r.date}</td><td class="text-center">${r.shift || '-'}</td><td class="text-center">${r.machine}</td><td class="text-center">${typeLabel}</td><td class="text-center font-bold text-blue-700">${worker}</td><td class="text-center">${r.description || '-'}</td><td class="font-bold text-red-600">${r.durationMinutes}</td></tr>`);
        });
        rows.push(`<tr class="total-row"><td colspan="7" class="font-bold text-right">Total Downtime:</td><td class="font-bold text-red-600">${totalDur} minutes (${(totalDur / 60).toFixed(2)} hours)</td></tr>`);
        body.innerHTML = rows.join('');
    }
    document.getElementById('reportResults').classList.remove('hidden');
    document.getElementById('reportResults').scrollIntoView({ behavior: 'smooth' });
}

function getMachinePhase(machine) {
    const m = machine.toLowerCase();
    if (['206', '20.20', '10.10', '83p'].some(x => m === x)) return 'minimum';
    if (['cropping', 'manual plasma'].some(x => m.includes(x))) return 'cropping';
    if (m === 'shear') return 'shearing';
    if (['press', 'cnc bending'].some(x => m.includes(x))) return 'bending';
    if (m === 'chamfering') return 'chamfering';
    return '';
}

function generateNCRReport() {
    if (!hasPermission('canViewReports')) { showToast('غير مسموح لك بعرض التقارير', 'error'); return; }
    const fromDate = document.getElementById('ncrReportFromDate').value;
    const toDate = document.getElementById('ncrReportToDate').value;
    const machine = document.getElementById('ncrReportMachine').value;
    const ncrType = document.getElementById('ncrReportType').value;
    if (!fromDate || !toDate) { showToast('Please select date range', 'warning'); return; }
    const fromD = new Date(fromDate), toD = new Date(toDate);
    let filtered = ncrDB.filter(rec => {
        const recDate = new Date(rec.date);
        if (recDate < fromD || recDate > toD) return false;
        if (machine && rec.machine !== machine) return false;
        if (ncrType && rec.ncrType !== ncrType) return false;
        return true;
    });
    filtered.sort((a, b) => new Date(b.date) - new Date(a.date) || b.timestamp - a.timestamp);
    document.getElementById('reportTitle').textContent = `NCR Report (${fromDate} to ${toDate})`;
    const header = document.getElementById('reportTableHeader');
    const body = document.getElementById('reportTableBody');
    header.innerHTML = `<tr><th>#</th><th>Date</th><th>Shift</th><th>Machine</th><th>Work Order</th><th>Item Name</th><th>Rejected Qty</th><th>NCR Type</th><th>NCR Cause</th><th>Worker Name</th><th>Comment</th></tr>`;
    if (filtered.length === 0) body.innerHTML = '<tr><td colspan="11" class="text-center py-4">No NCR records found</td></tr>';
    else {
        let totalRejected = 0;
        const rows = [];
        const causeLabels = {
            'Worker': 'عامل (Worker)',
            'Machine': 'ماكينة (Machine)',
            'Drawing': 'الرسم الهندسي (Workshop Drawing)',
            'Material': 'خامة (Material)'
        };
        filtered.forEach((rec, idx) => {
            totalRejected += rec.rejectedQty;
            const causeLabel = rec.ncrCause ? (causeLabels[rec.ncrCause] || rec.ncrCause) : '-';
            const workerName = (rec.ncrCause === 'Worker' && rec.ncrWorkerName) ? rec.ncrWorkerName : '-';
            rows.push(`<tr><td class="text-center">${idx + 1}</td><td class="text-center">${rec.date}</td><td class="text-center">${rec.shift}</td><td class="text-center">${rec.machine}</td><td class="text-center">${rec.workOrderName}</td><td class="text-center">${rec.itemName}</td><td class="text-center font-bold text-red-600">${rec.rejectedQty}</td><td class="text-center"><span class="badge ${rec.ncrType === 'Scrap' ? 'badge-danger' : (rec.ncrType === 'Accept as it is' ? 'badge-warning' : 'badge-info')}">${rec.ncrType}</span></td><td class="text-center font-bold">${causeLabel}</td><td class="text-center text-blue-700">${workerName}</td><td class="text-center">${rec.comment || '-'}</td></tr>`);
        });
        rows.push(`<tr class="total-row"><td colspan="6" class="font-bold text-right">Total Rejected:</td><td class="font-bold text-red-600">${totalRejected}</td><td colspan="4"></td></tr>`);
        body.innerHTML = rows.join('');
    }
    document.getElementById('reportResults').classList.remove('hidden');
    document.getElementById('reportResults').scrollIntoView({ behavior: 'smooth' });
    showToast('NCR report generated', 'success');
}

function generateOEEReport() {
    if (!hasPermission('canViewReports')) { showToast('غير مسموح لك بعرض التقارير', 'error'); return; }
    const fromDate = document.getElementById('oeeReportFromDate').value;
    const toDate = document.getElementById('oeeReportToDate').value;
    const machine = document.getElementById('oeeReportMachine').value;
    if (!fromDate || !toDate) { showToast('Please select date range', 'warning'); return; }
    const machines = machine ? [machine] : ['206', '20.20', '10.10', 'Cropping', 'Manual Plasma', 'Press', 'Drill', 'Chamfering', 'Shear', '83P', 'CNC Bending', 'Finishing'];
    let results = [];
    for (const m of machines) {
        const metrics = calculateOEEAndTEEPForMachine(m, fromDate, toDate);
        if (metrics && metrics.totalPlannedMinutes > 0) {
            results.push({ machine: m, availability: (metrics.availability * 100).toFixed(1), performance: (metrics.performance * 100).toFixed(1), quality: (metrics.quality * 100).toFixed(1), oee: (metrics.oee * 100).toFixed(1), totalProduced: metrics.totalProduced, totalRejected: metrics.totalRejected });
        }
    }
    document.getElementById('reportTitle').textContent = `OEE Report (${fromDate} to ${toDate})`;
    const header = document.getElementById('reportTableHeader');
    const body = document.getElementById('reportTableBody');
    header.innerHTML = `<tr><th>#</th><th>Machine</th><th>Availability (%)</th><th>Performance (%)</th><th>Quality (%)</th><th>OEE (%)</th><th>Total Produced</th><th>Total Rejected</th></tr>`;
    if (results.length === 0) body.innerHTML = '<tr><td colspan="8" class="text-center py-4">No OEE data available for the selected period</td></tr>';
    else {
        const rows = [];
        results.forEach((res, idx) => {
            let oeeColor = '';
            if (parseFloat(res.oee) >= 85) oeeColor = 'text-green-600';
            else if (parseFloat(res.oee) >= 65) oeeColor = 'text-yellow-600';
            else oeeColor = 'text-red-600';
            rows.push(`<tr><td class="text-center">${idx + 1}</td><td class="font-bold">${res.machine}</td><td class="text-center">${res.availability}%</td><td class="text-center">${res.performance}%</td><td class="text-center">${res.quality}%</td><td class="text-center font-bold ${oeeColor}">${res.oee}%</td><td class="text-center">${res.totalProduced}</td><td class="text-center text-red-600">${res.totalRejected}</td></tr>`);
        });
        body.innerHTML = rows.join('');
    }
    document.getElementById('reportResults').classList.remove('hidden');
    document.getElementById('reportResults').scrollIntoView({ behavior: 'smooth' });
    showToast('OEE report generated', 'success');
}

function generateTEEPReport() {
    if (!hasPermission('canViewReports')) { showToast('غير مسموح لك بعرض التقارير', 'error'); return; }
    const fromDate = document.getElementById('teepReportFromDate').value;
    const toDate = document.getElementById('teepReportToDate').value;
    const machine = document.getElementById('teepReportMachine').value;
    if (!fromDate || !toDate) { showToast('Please select date range', 'warning'); return; }
    const machines = machine ? [machine] : ['206', '20.20', '10.10', 'Cropping', 'Manual Plasma', 'Press', 'Drill', 'Chamfering', 'Shear', '83P', 'CNC Bending', 'Finishing'];
    let results = [];
    for (const m of machines) {
        const metrics = calculateOEEAndTEEPForMachine(m, fromDate, toDate);
        if (metrics && metrics.totalPlannedMinutes > 0) {
            results.push({ machine: m, oee: (metrics.oee * 100).toFixed(1), teep: (metrics.teep * 100).toFixed(1), utilization: (metrics.utilization * 100).toFixed(1), totalProduced: metrics.totalProduced, totalRejected: metrics.totalRejected, plannedMinutes: metrics.totalPlannedMinutes, calendarMinutes: metrics.totalCalendarMinutes });
        }
    }
    document.getElementById('reportTitle').textContent = `TEEP Report (${fromDate} to ${toDate})`;
    const header = document.getElementById('reportTableHeader');
    const body = document.getElementById('reportTableBody');
    header.innerHTML = `<tr><th>#</th><th>Machine</th><th>OEE (%)</th><th>Utilization (%)</th><th>TEEP (%)</th><th>Total Produced</th><th>Total Rejected</th><th>Planned (hrs)</th><th>Calendar (hrs)</th></tr>`;
    if (results.length === 0) body.innerHTML = '<tr><td colspan="9" class="text-center py-4">No TEEP data available for the selected period</td></tr>';
    else {
        const rows = [];
        results.forEach((res, idx) => {
            let teepColor = '';
            if (parseFloat(res.teep) >= 85) teepColor = 'text-green-600';
            else if (parseFloat(res.teep) >= 65) teepColor = 'text-yellow-600';
            else teepColor = 'text-red-600';
            rows.push(`<tr><td class="text-center">${idx + 1}</td><td class="font-bold">${res.machine}</td><td class="text-center">${res.oee}%</td><td class="text-center">${res.utilization}%</td><td class="text-center font-bold ${teepColor}">${res.teep}%</td><td class="text-center">${res.totalProduced}</td><td class="text-center text-red-600">${res.totalRejected}</td><td class="text-center">${(res.plannedMinutes / 60).toFixed(1)}</td><td class="text-center">${(res.calendarMinutes / 60).toFixed(1)}</td></tr>`);
        });
        body.innerHTML = rows.join('');
    }
    document.getElementById('reportResults').classList.remove('hidden');
    document.getElementById('reportResults').scrollIntoView({ behavior: 'smooth' });
    showToast('TEEP report generated', 'success');
}

async function generateProjectStageSummary() {
    if (!hasPermission('canViewReports')) { showToast('غير مسموح لك بعرض التقارير', 'error'); return; }
    const salesOrderFilter = document.getElementById('stageSummarySO') ? document.getElementById('stageSummarySO').value : '';
    showLoading(translations[currentLanguage].processing || 'Processing...');
    await yieldToUI();
    try {
        const scope = workOrdersDB.filter(wo => (!salesOrderFilter || wo.salesOrderNumber === salesOrderFilter));
        const agg = computeStageSummary(scope);
        const scopeLabel = salesOrderFilter ? ('SO ' + salesOrderFilter) : ((translations[currentLanguage].allSalesOrders) || 'All Sales Orders');
        document.getElementById('reportTitle').textContent = `Project Stage Summary - ${scopeLabel}`;
        document.getElementById('reportTableHeader').innerHTML = buildStageSummaryHeaderHTML();
        document.getElementById('reportTableBody').innerHTML = buildStageSummaryRowsHTML(agg);
        document.getElementById('reportResults').classList.remove('hidden');
        document.getElementById('reportResults').scrollIntoView({ behavior: 'smooth' });
        showToast('Project stage summary generated', 'success');
    } catch (err) { console.error(err); showToast('Error generating report', 'error'); }
    finally { hideLoading(); }
}

async function generateMinimumStoppageReport() {
    if (!hasPermission('canViewReports')) { showToast('غير مسموح لك بعرض التقارير', 'error'); return; }
    const soFilter = document.getElementById('minStopSO') ? document.getElementById('minStopSO').value : '';
    const categoryFilter = document.getElementById('minStopCategory') ? document.getElementById('minStopCategory').value : 'all';
    showLoading(translations[currentLanguage].processing || 'Processing...');
    await yieldToUI();
    try {
        const scope = workOrdersDB.filter(wo => (!soFilter || wo.salesOrderNumber === soFilter));
        const rows = [];
        let totalQty = 0, totalWt = 0;
        scope.forEach(wo => {
            (wo.items || []).forEach(item => {
                const qty = parseInt(item.quantity) || 0;
                if (qty <= 0) return;
                const section = (item.section || '').toString().trim().toUpperCase();
                let include = true;
                if (categoryFilter === 'angles') { if (!section.startsWith('L')) include = false; }
                else if (categoryFilter === 'plates') { if (!(section.startsWith('P') || section.startsWith('F'))) include = false; }
                if (!include) return;
                const ops = item.operations || [];
                const co = item.completedOperations || {};
                const doneOf = (op) => { const c = co[op.name]; return c ? (parseInt(c.completedQuantity) || 0) : 0; };
                const minIndices = [];
                ops.forEach((op, i) => { if (getOperationPhase(op.name) === 'minimum') minIndices.push(i); });
                if (minIndices.length === 0) return;
                const minComplete = minIndices.every(i => doneOf(ops[i]) >= qty);
                if (!minComplete) return;
                const lastMin = minIndices[minIndices.length - 1];
                let stuck = null, stuckDone = 0;
                for (let i = lastMin + 1; i < ops.length; i++) {
                    const d = doneOf(ops[i]);
                    if (d < qty) { stuck = ops[i]; stuckDone = d; break; }
                }
                if (!stuck) return;
                const wt = parseFloat(item.totalWeight) || ((parseFloat(item.weightPerPiece) || 0) * qty) || 0;
                totalQty += qty;
                totalWt += wt;
                let categoryLabel = 'Other';
                if (section.startsWith('L')) categoryLabel = 'Angle';
                else if (section.startsWith('P') || section.startsWith('F')) categoryLabel = 'Plate';
                rows.push({ salesOrder: wo.salesOrderNumber || '-', woName: wo.workOrderName, itemName: item.itemName, section: item.section || '-', category: categoryLabel, qty: qty, wt: wt, stage: stuck.name, machine: stuck.machine || '-', stuckDone: stuckDone });
            });
        });
        rows.sort((a, b) => String(a.stage).localeCompare(String(b.stage)) || String(a.woName).localeCompare(String(b.woName)) || String(a.itemName).localeCompare(String(b.itemName)));
        const scopeLabel = soFilter ? ('SO ' + soFilter) : ((translations[currentLanguage].allSalesOrders) || 'All Sales Orders');
        document.getElementById('reportTitle').textContent = `WIP After Minimum - ${scopeLabel}`;
        const header = document.getElementById('reportTableHeader');
        const body = document.getElementById('reportTableBody');
        header.innerHTML = `<tr><th>#</th><th>Sales Order</th><th>Work Order</th><th>Item Name</th><th>Section</th><th>Category</th><th>Quantity</th><th>Weight (kg)</th><th>Stopped At Stage</th><th>Machine</th><th>Stage Progress</th></tr>`;
        if (rows.length === 0) body.innerHTML = '<tr><td colspan="11" class="text-center py-4">No items found</td></tr>';
        else {
            const fmtInt = (n) => Math.round(Number(n) || 0).toLocaleString('en-US');
            const out = rows.map((r, i) => `<tr><td class="text-center">${i + 1}</td><td class="text-center">${esc(r.salesOrder)}</td><td class="text-center">${esc(r.woName)}</td><td class="font-bold">${esc(r.itemName)}</td><td class="text-center">${esc(r.section)}</td><td class="text-center"><span class="badge ${r.category === 'Angle' ? 'badge-primary' : (r.category === 'Plate' ? 'badge-warning' : 'badge-secondary')}">${esc(r.category)}</span></td><td class="text-center">${fmtInt(r.qty)}</td><td class="text-center">${fmtInt(r.wt)}</td><td class="text-center"><span class="status-indicator status-in-progress">${esc(r.stage)}</span></td><td class="text-center">${esc(r.machine)}</td><td class="text-center">${fmtInt(r.stuckDone)} / ${fmtInt(r.qty)}</td></tr>`);
            out.push(`<tr class="total-row" style="background:#fef3c7;font-weight:700;"><td class="text-center"></td><td class="text-center"></td><td class="text-center font-bold">TOTAL</td><td class="text-center font-bold">${fmtInt(rows.length)} item(s)</td><td class="text-center"></td><td class="text-center"></td><td class="text-center font-bold">${fmtInt(totalQty)}</td><td class="text-center font-bold">${fmtInt(totalWt)}</td><td class="text-center"></td><td class="text-center"></td><td class="text-center"></td></tr>`);
            body.innerHTML = out.join('');
        }
        document.getElementById('reportResults').classList.remove('hidden');
        document.getElementById('reportResults').scrollIntoView({ behavior: 'smooth' });
        showToast('Report generated', 'success');
    } catch (err) { console.error(err); showToast('Error generating report', 'error'); }
    finally { hideLoading(); }
}

// ====== Export Functions ======
function exportWorkOrderToExcel() {
    if (!currentWorkOrder) return;
    const data = [['Work Order Information']];
    data.push(['Work Order Name:', currentWorkOrder.workOrderName]);
    data.push(['Project Name:', currentWorkOrder.projectName]);
    data.push(['Sales Order Number:', currentWorkOrder.salesOrderNumber]);
    data.push(['Tower Type:', currentWorkOrder.type]);
    data.push(['Model:', currentWorkOrder.model]);
    data.push(['Creation Date:', currentWorkOrder.date]);
    data.push([]);
    data.push(['#', 'Item Name', 'Section', 'Steel Grade', 'Length', 'Quantity', 'Weight/Piece', 'Total Weight', 'Operations', 'Completed', 'Remaining', 'Status']);
    currentWorkOrder.items.forEach((it, idx) => {
        let opsText = '';
        if (it.operations && it.operations.length) {
            opsText = it.operations.map(op => {
                const comp = it.completedOperations && it.completedOperations[op.name];
                const compQty = comp ? comp.completedQuantity : 0;
                return `${op.name} (${compQty}/${it.quantity})`;
            }).join('; ');
        }
        data.push([idx + 1, it.itemName, it.section, it.steelGrade || '-', it.length || '-', it.quantity, it.weightPerPiece || 0, it.totalWeight || 0, opsText, it.completedQuantity || 0, it.quantity - (it.completedQuantity || 0), it.status]);
    });
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Work Order');
    XLSX.writeFile(wb, `${currentWorkOrder.workOrderName}_${currentWorkOrder.date.replace(/\//g, '-')}.xlsx`);
    showToast('Work order exported to Excel', 'success');
}

function exportProductionToExcel() {
    if (!currentProduction) return;
    const data = [['Production Record Information']];
    data.push(['Item:', currentProduction.itemName]);
    data.push(['Project:', currentProduction.projectName]);
    data.push(['Work Order:', currentProduction.workOrderName]);
    data.push(['Machine:', currentProduction.machine]);
    data.push(['Operation:', currentProduction.operation]);
    data.push(['Operator:', currentProduction.operator]);
    data.push(['Quantity:', currentProduction.quantity]);
    data.push(['Rejected:', currentProduction.rejectedQty || 0]);
    data.push(['Weight Produced:', currentProduction.producedWeight || 0]);
    data.push(['Weight/Piece:', currentProduction.weightPerPiece || 0]);
    data.push(['Total Item Weight:', currentProduction.totalItemWeight || 0]);
    data.push(['Shift:', currentProduction.shift]);
    data.push(['Date:', currentProduction.date]);
    const ws = XLSX.utils.aoa_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Production Record');
    XLSX.writeFile(wb, `Production_${currentProduction.itemName}_${currentProduction.date.replace(/\//g, '-')}.xlsx`);
    showToast('Production record exported to Excel', 'success');
}

function exportReportToExcel() {
    if (!hasPermission('canExportReports')) { showToast('غير مسموح لك بتصدير التقارير', 'error'); return; }
    const title = document.getElementById('reportTitle').textContent;
    const headers = Array.from(document.querySelectorAll('#reportTableHeader th')).map(th => th.textContent);
    const isWeightHeader = (h) => {
        const t = (h || '').toLowerCase();
        return t.includes('weight') || t.includes('kg') || t.includes('\u0648\u0632\u0646') || t.includes('\u0643\u062c\u0645');
    };
    const weightCols = headers.map(isWeightHeader);
    const toNumber = (text) => {
        const cleaned = String(text).replace(/[^\d.,-]/g, '').replace(/,/g, '');
        if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
        const n = parseFloat(cleaned);
        return isNaN(n) ? null : n;
    };
    const rows = Array.from(document.querySelectorAll('#reportTableBody tr')).map(tr =>
        Array.from(tr.querySelectorAll('td')).map((td, c) => {
            const text = td.textContent;
            if (weightCols[c]) { const n = toNumber(text); if (n !== null) return n; }
            return text;
        })
    );
    const out = [[title], [], ['@2026 Created by Walid Ahmed Yosuf'], ['Report Generated:', new Date().toLocaleString()], []];
    out.push(headers);
    rows.forEach(r => out.push(r));
    const ws = XLSX.utils.aoa_to_sheet(out);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Report');
    XLSX.writeFile(wb, `Report_${title.replace(/[^\w\s]/gi, '').replace(/\s+/g, '-').replace(/--+/g, '-').replace(/^-+|-+$/g, '')}_${new Date().toISOString().split('T')[0]}.xlsx`);
    showToast('Report exported to Excel', 'success');
}

function exportReportToPdf() {
    if (!hasPermission('canExportReports')) { showToast('غير مسموح لك بتصدير التقارير', 'error'); return; }
    const titleEl = document.getElementById('reportTitle');
    const title = titleEl ? titleEl.textContent : 'Report';
    const headers = Array.from(document.querySelectorAll('#reportTableHeader th')).map(th => th.textContent.trim());
    const rows = Array.from(document.querySelectorAll('#reportTableBody tr')).map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim()));
    if (headers.length === 0 || rows.length === 0) { showToast('No report to export', 'warning'); return; }
    const jsPDFCtor = (window.jspdf && window.jspdf.jsPDF) ? window.jspdf.jsPDF : (window.jsPDF || null);
    if (!jsPDFCtor) { showToast('PDF library not loaded', 'warning'); printReport(); return; }
    try {
        const doc = new jsPDFCtor({ orientation: 'landscape', unit: 'pt', format: 'a4' });
        const pageWidth = doc.internal.pageSize.getWidth();
        const pageHeight = doc.internal.pageSize.getHeight();
        doc.setFontSize(14); doc.setTextColor(26, 35, 126);
        doc.text('Tower Manufacturing Management System', pageWidth / 2, 30, { align: 'center' });
        doc.setFontSize(11); doc.setTextColor(40, 40, 40);
        doc.text(title, pageWidth / 2, 48, { align: 'center' });
        doc.setFontSize(8); doc.setTextColor(120, 120, 120);
        doc.text('@2026 Created by Walid Ahmed Yosuf   |   Generated: ' + new Date().toLocaleString(), pageWidth / 2, 62, { align: 'center' });
        const autoTableFn = (typeof doc.autoTable === 'function') ? doc.autoTable.bind(doc) : ((window.jspdf && typeof window.jspdf.autoTable === 'function') ? (opts) => window.jspdf.autoTable(doc, opts) : null);
        if (!autoTableFn) { showToast('PDF table plugin not loaded', 'warning'); printReport(); return; }
        autoTableFn({
            head: [headers], body: rows, startY: 75,
            margin: { left: 20, right: 20 },
            styles: { fontSize: 8, cellPadding: 4, overflow: 'linebreak', halign: 'center', valign: 'middle' },
            headStyles: { fillColor: [26, 35, 126], textColor: 255, fontStyle: 'bold', halign: 'center' },
            alternateRowStyles: { fillColor: [243, 244, 246] },
            didParseCell: function (data) {
                if (data.section === 'body') {
                    const r = rows[data.row.index] || [];
                    const joined = r.join(' ').toUpperCase();
                    if (joined.indexOf('TOTAL') !== -1) { data.cell.styles.fillColor = [254, 243, 199]; data.cell.styles.fontStyle = 'bold'; }
                }
            },
            didDrawPage: function () {
                doc.setFontSize(7); doc.setTextColor(150, 150, 150);
                doc.text('Confidential - Tower Manufacturing Management System   |   Page ' + doc.internal.getNumberOfPages(), pageWidth / 2, pageHeight - 12, { align: 'center' });
            }
        });
        const safeName = title.replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
        doc.save('Report_' + safeName + '_' + new Date().toISOString().split('T')[0] + '.pdf');
        showToast('Report exported to PDF', 'success');
    } catch (err) { console.error('PDF export failed:', err); showToast('PDF export failed', 'error'); printReport(); }
}

function printReport() {
    const title = document.getElementById('reportTitle').textContent;
    const headers = Array.from(document.querySelectorAll('#reportTableHeader th')).map(th => th.textContent);
    const rows = Array.from(document.querySelectorAll('#reportTableBody tr')).map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.textContent));
    let woInfo = '', woId = null;
    if (document.getElementById('reportWorkOrder') && document.getElementById('reportWorkOrder').value) woId = parseInt(document.getElementById('reportWorkOrder').value);
    else if (document.getElementById('detailReportWorkOrder') && document.getElementById('detailReportWorkOrder').value) woId = parseInt(document.getElementById('detailReportWorkOrder').value);
    if (woId) { const wo = workOrdersDB.find(w => w.id === woId); if (wo) woInfo = `Project: ${wo.projectName} | Work Order: ${wo.workOrderName} | Sales Order: ${wo.salesOrderNumber}`; }
    const html = `<!DOCTYPE html><html><head><title>${title}</title><style>body{font-family:Arial;margin:20px}.print-header{border-bottom:2px solid #1a237e;padding-bottom:10px;margin-bottom:20px;text-align:center}.print-title{color:#1a237e;font-size:18px;font-weight:bold}table{width:100%;border-collapse:collapse;margin-top:20px}th{background:#1a237e;color:white;padding:8px;border:1px solid #ddd}td{padding:6px;border:1px solid #ddd}.summary-row{background:#e8eaf6}.total-row{background:#fef3c7}</style></head><body><div class="print-header"><h1 class="print-title">Tower Manufacturing Management System</h1><h2>${title}</h2>${woInfo ? `<p>${woInfo}</p>` : ''}<p>@2026 Created by Walid Ahmed Yosuf</p><p>Generated: ${new Date().toLocaleString()}</p></div><table><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table><div class="print-footer"><p>Confidential - Tower Manufacturing Management System</p></div></body></html>`;
    const win = window.open('', '_blank');
    win.document.write(html);
    win.document.close();
    win.focus();
    win.print();
    showToast('Report sent to printer', 'success');
}

async function generateWorkOrderStatusReport() {
    if (!currentWorkOrder || !hasPermission('canViewReports')) return;
    function nextFrame() { return new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0))); }
    switchTab('reports');
    await nextFrame();
    selectReportType('itemsStatus');
    await nextFrame();
    const sel = document.getElementById('reportWorkOrder');
    if (sel) sel.value = currentWorkOrder.id;
    await nextFrame();
    await generateItemsStatusReport();
}

// ====== Backup, Settings, Modals ======
function showModal(id) { document.getElementById(id).classList.add('active'); document.body.style.overflow = 'hidden'; }
function hideModal(id) { document.getElementById(id).classList.remove('active'); document.body.style.overflow = 'auto'; }
function showLoading(text = 'Processing...') { document.getElementById('loadingText').textContent = text; document.getElementById('loadingModal').classList.add('active'); }
function hideLoading() { document.getElementById('loadingModal').classList.remove('active'); }

function showToast(msg, type = 'success') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    let icon = type === 'success' ? 'fa-check-circle' : (type === 'error' ? 'fa-exclamation-circle' : (type === 'warning' ? 'fa-exclamation-triangle' : 'fa-info-circle'));
    toast.innerHTML = `<i class="fa-solid ${icon}"></i><span>${msg}</span><button class="toast-close" onclick="this.parentElement.remove()"><i class="fa-solid fa-times"></i></button>`;
    container.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => { if (toast.parentElement) { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); } }, 5000);
}

function switchTab(tab) {
    const permissionMap = {
        dashboard: 'canViewDashboard', models: 'canViewModels', workOrder: 'canViewWorkOrders',
        production: 'canViewProduction', downtime: 'canViewDowntime', ncr: 'canViewNCR',
        hr: 'canViewHR', reports: 'canViewReports', settings: 'canViewSettings'
    };
    if (!hasPermission(permissionMap[tab])) { showToast('غير مسموح لك بالدخول إلى هذا القسم', 'error'); return; }
    if (tab === 'settings') { showSettingsPanel(); return; }
    document.querySelectorAll('section[id$="Section"]').forEach(s => s.classList.add('hidden'));
    document.querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
    document.getElementById(`${tab}Section`).classList.remove('hidden');
    document.querySelector(`.sidebar-tab[data-tab="${tab}"]`).classList.add('active');
    if (tab === 'workOrder') populateTowerTypeDropdown();
    else if (tab === 'production') { populateProductionTowerTypeDropdown(); loadProductionPreferences(); renderProductionList(); }
    else if (tab === 'reports') { }
    else if (tab === 'downtime') {
        document.getElementById('downtimeDate').value = getLocalDateStr();
        const workerGroup = document.getElementById('workerNameGroup');
        const workerInput = document.getElementById('downtimeWorkerName');
        if (workerGroup) workerGroup.classList.add('hidden');
        if (workerInput) { workerInput.value = ''; workerInput.required = false; }
        renderDowntimeList();
    }
    else if (tab === 'ncr') {
        document.getElementById('ncrDate').value = getLocalDateStr();
        const woSearch = document.getElementById('ncrWorkOrderSearch');
        const itemSearch = document.getElementById('ncrItemSearch');
        if (woSearch) woSearch.value = '';
        if (itemSearch) itemSearch.value = '';
        const ncrWorkerGroup = document.getElementById('ncrWorkerNameGroup');
        const ncrWorkerInput = document.getElementById('ncrWorkerName');
        if (ncrWorkerGroup) ncrWorkerGroup.classList.add('hidden');
        if (ncrWorkerInput) { ncrWorkerInput.value = ''; ncrWorkerInput.required = false; }
        populateNCRWorkOrders();
        renderNCRList();
    }
    else if (tab === 'hr') { renderEmployeesList(); updateEmployeesStats(); }
    else if (tab === 'dashboard') renderDashboard();
    applyPermissionsToCurrentSection();
}

function showBackupModal() { showModal('backupModal'); }

function createBackup() {
    try {
        showLoading(translations[currentLanguage].processing);
        const backup = { version: appConfig.version, timestamp: new Date().toISOString(), data: { towerDB: db, workOrdersDB, productionDB, machineOperatorsDB, productionPreferences, appSettings: appConfig.settings, downtimeDB, machineIdealRates, ncrDB, employeesDB, usersDB } };
        const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `tower-backup-${new Date().toISOString().split('T')[0]}.json`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        URL.revokeObjectURL(url);
        appConfig.lastBackup = new Date().toISOString(); localStorage.setItem('lastBackup', appConfig.lastBackup);
        hideLoading(); showToast(translations[currentLanguage].backupCreated, 'success');
    } catch (e) { hideLoading(); showToast('Error creating backup', 'error'); }
}

function handleBackupFileChange() { document.getElementById('restoreBackupBtn').disabled = document.getElementById('backupFile').files.length === 0; }

async function restoreFromBackup() {
    const file = document.getElementById('backupFile').files[0];
    if (!file) { showToast('Please select backup file', 'warning'); return; }
    const reader = new FileReader();
    reader.onload = async function (e) {
        try {
            showLoading(translations[currentLanguage].processing);
            const data = JSON.parse(e.target.result);
            if (!data.version || !data.data) throw new Error('Invalid backup');
            if (!confirm('All current data will be replaced. Are you sure?')) { hideLoading(); return; }
            db = data.data.towerDB || []; workOrdersDB = data.data.workOrdersDB || []; productionDB = data.data.productionDB || [];
            workOrdersDB.forEach(wo => { if (wo.archived === undefined) wo.archived = false; });
            machineOperatorsDB = data.data.machineOperatorsDB || {}; downtimeDB = data.data.downtimeDB || [];
            machineIdealRates = data.data.machineIdealRates || {}; ncrDB = data.data.ncrDB || [];
            employeesDB = data.data.employeesDB || [];
            usersDB = data.data.usersDB || [];
            productionPreferences = data.data.productionPreferences || { towerType: '', model: '', workOrderId: '', shift: '', machine: '', operator: '', date: new Date().toISOString().split('T')[0] };
            appConfig.settings = data.data.appSettings || appConfig.settings; appConfig.lastBackup = data.timestamp;
            repairLegacyCompletedQuantities();
            repairLegacyGalvanizingOperations();
            await saveAllData();
            updateStats(); renderModelsList(); renderWorkOrdersList(); renderProductionList(); renderDowntimeList(); renderNCRList(); renderEmployeesList(); renderDashboard();
            populateTowerTypeDropdown(); populateProductionTowerTypeDropdown(); populateReportDropdowns(); populateDailyReportWorkOrders(); updateOperatorsDropdown();
            await updateIdealRatesFromActual();
            hideLoading(); showToast(translations[currentLanguage].dataRestored, 'success'); hideModal('backupModal');
            document.getElementById('backupFile').value = ''; document.getElementById('restoreBackupBtn').disabled = true;
        } catch (err) { hideLoading(); showToast('Backup file is corrupted', 'error'); }
    };
    reader.readAsText(file);
}

function setBackupSchedule() { appConfig.backupSchedule = document.getElementById('backupSchedule').value; localStorage.setItem('backupSchedule', appConfig.backupSchedule); showToast(translations[currentLanguage].saveSchedule, 'success'); }
function checkScheduledBackup() { if (appConfig.backupSchedule === 'none') return; const now = new Date(); const last = appConfig.lastBackup ? new Date(appConfig.lastBackup) : null; let should = false; if (!last) should = true; else { const days = (now - last) / (1000 * 60 * 60 * 24); if (appConfig.backupSchedule === 'daily' && days >= 1) should = true; else if (appConfig.backupSchedule === 'weekly' && days >= 7) should = true; else if (appConfig.backupSchedule === 'monthly' && days >= 30) should = true; } if (should) showToast('Scheduled backup time has arrived', 'warning'); }
function setBackupScheduleInterval() { setInterval(checkScheduledBackup, 60 * 60 * 1000); }
function exportBackup() { createBackup(); }

function showConfirmationDialog(title, msg, action, data) {
    document.getElementById('confirmationTitle').textContent = title;
    document.getElementById('confirmationMessage').innerHTML = msg;
    pendingDeleteAction = action;
    pendingDeleteData = data;
    showModal('confirmationModal');
}

async function confirmAction() {
    if (pendingDeleteAction && pendingDeleteData) await pendingDeleteAction(pendingDeleteData);
    hideModal('confirmationModal');
    pendingDeleteAction = null;
    pendingDeleteData = null;
}

function showDeleteProductionConfirmation(id) {
    if (!hasPermission('canDeleteProduction')) return;
    const t = translations[currentLanguage];
    const rec = productionDB.find(r => r.id === id);
    if (!rec) return;
    showConfirmationDialog(t.deleteRecord, `${t.areYouSureDeleteProduction}<br><br><strong>${esc(rec.itemName)}</strong><br>${esc(rec.operation)} - ${rec.quantity} pieces<br>${rec.date} - ${rec.shift}`, deleteProductionRecord, id);
}

function showDeleteWorkOrderConfirmation(id) {
    if (!hasPermission('canDeleteWorkOrder')) return;
    const t = translations[currentLanguage];
    const wo = workOrdersDB.find(w => w.id === id);
    if (!wo) return;
    showConfirmationDialog(t.deleteWorkOrder, `${t.areYouSureDeleteWorkOrder}<br><br><strong>${esc(wo.workOrderName)}</strong><br>${esc(wo.projectName)}<br>${wo.items.length} items`, deleteWorkOrder, id);
}

function showDeleteModelConfirmation(id) {
    if (!hasPermission('canDeleteModel')) return;
    const t = translations[currentLanguage];
    const m = db.find(m => m.id === id);
    if (!m) return;
    showConfirmationDialog(t.deleteModel, `${t.areYouSureDeleteModel}<br><br><strong>${esc(m.model)}</strong><br>${esc(m.type)}<br>${m.items.length} items`, deleteModel, id);
}

function showDeleteDowntimeConfirmation(id) {
    if (!hasPermission('canDeleteDowntime')) return;
    const t = translations[currentLanguage];
    const rec = downtimeDB.find(r => r.id === id);
    if (!rec) return;
    const workerInfo = (rec.downtimeType === 'Worker' && rec.workerName) ? `<br>Worker: ${esc(rec.workerName)}` : '';
    showConfirmationDialog(t.deleteRecord, `${t.areYouSureDeleteDowntime}<br><br><strong>${esc(rec.machine)}</strong><br>${esc(rec.downtimeType)} - ${rec.durationMinutes} min${workerInfo}<br>${rec.date} - ${rec.shift || 'N/A'}`, deleteDowntimeRecord, id);
}

function showDeleteNCRConfirmation(id) {
    if (!hasPermission('canDeleteNCR')) return;
    const t = translations[currentLanguage];
    const rec = ncrDB.find(r => r.id === id);
    if (!rec) return;
    const causeLabels = { 'Worker': 'عامل', 'Machine': 'ماكينة', 'Drawing': 'الرسم الهندسي', 'Material': 'خامة' };
    const causeInfo = rec.ncrCause ? `<br>السبب: ${causeLabels[rec.ncrCause] || rec.ncrCause}` : '';
    const workerInfo = (rec.ncrCause === 'Worker' && rec.ncrWorkerName) ? `<br>اسم العامل: ${esc(rec.ncrWorkerName)}` : '';
    showConfirmationDialog(t.deleteRecord, `${t.areYouSureDeleteNCR}<br><br><strong>${esc(rec.itemName)}</strong><br>${esc(rec.ncrType)} - ${rec.rejectedQty} pcs${causeInfo}${workerInfo}<br>${rec.date} - ${rec.shift}`, deleteNCRRecord, id);
}

async function deleteProductionRecord(id) {
    if (!hasPermission('canDeleteProduction')) { showToast('غير مسموح لك بحذف سجلات الإنتاج', 'error'); return; }
    const t = translations[currentLanguage];
    const idx = productionDB.findIndex(r => r.id === id);
    if (idx === -1) return;
    const rec = productionDB[idx];
    const woIdx = workOrdersDB.findIndex(w => w.id === rec.workOrderId);
    if (woIdx !== -1) {
        const wo = workOrdersDB[woIdx];
        const itIdx = wo.items.findIndex(it => it.itemName === rec.itemName);
        if (itIdx !== -1) {
            const it = wo.items[itIdx];
            if (it.completedOperations && it.completedOperations[rec.operation]) {
                it.completedOperations[rec.operation].completedQuantity -= rec.quantity;
                if (it.completedOperations[rec.operation].completedQuantity < 0) it.completedOperations[rec.operation].completedQuantity = 0;
                it.completedOperations[rec.operation].completed = it.completedOperations[rec.operation].completedQuantity >= it.quantity;
                it.completedQuantity = recalcItemCompletedQuantity(it);
                recalcItemStatus(it);
                workOrdersDB[woIdx] = wo;
                const woSaveResult = await saveToServer('workOrdersDB', workOrdersDB);
                if (!woSaveResult || !woSaveResult.success) { showToast('تعذّر تحديث أمر الشغل على الخادم.', 'error'); return; }
            }
        }
    }
    productionDB.splice(idx, 1);
    await deleteProductionRecordOnServer(rec.id);
    updateStats(); renderProductionList(); renderWorkOrdersList(); renderDashboard();
    await updateIdealRatesFromActual();
    showToast(t.productionDeleted, 'success');
}

async function deleteWorkOrder(id) {
    if (!hasPermission('canDeleteWorkOrder')) { showToast('غير مسموح لك بحذف أوامر العمل', 'error'); return; }
    const t = translations[currentLanguage];
    if (productionDB.some(r => r.workOrderId === id)) { showToast(t.workOrderHasProduction, 'error'); return; }
    const idx = workOrdersDB.findIndex(w => w.id === id);
    if (idx === -1) return;
    workOrdersDB.splice(idx, 1);
    await saveToServer('workOrdersDB', workOrdersDB);
    updateStats(); renderWorkOrdersList(); populateDailyReportWorkOrders(); populateReportDropdowns();
    if (currentWorkOrder && currentWorkOrder.id === id) hideWorkOrderDetails();
    renderDashboard();
    showToast(t.workOrderDeleted, 'success');
}

async function deleteModel(id) {
    if (!hasPermission('canDeleteModel')) { showToast('غير مسموح لك بحذف النماذج', 'error'); return; }
    const t = translations[currentLanguage];
    const idx = db.findIndex(m => m.id === id);
    if (idx === -1) return;
    const m = db[idx];
    if (workOrdersDB.some(w => w.type === m.type && w.model === m.model)) { showToast(t.modelHasWorkOrders, 'error'); return; }
    db.splice(idx, 1);
    await saveToServer('towerDB', db);
    updateStats(); renderModelsList(); populateTowerTypeDropdown(); populateProductionTowerTypeDropdown(); populateReportDropdowns();
    if (document.getElementById('viewTitle').textContent === m.model) hideDetails();
    showToast(t.modelDeleted, 'success');
}

async function deleteDowntimeRecord(id) {
    if (!hasPermission('canDeleteDowntime')) { showToast('غير مسموح لك بحذف سجلات التوقفات', 'error'); return; }
    const t = translations[currentLanguage];
    const idx = downtimeDB.findIndex(r => r.id === id);
    if (idx === -1) return;
    downtimeDB.splice(idx, 1);
    await saveToServer('downtimeDB', downtimeDB);
    updateStats(); renderDowntimeList(); renderDashboard();
    await updateIdealRatesFromActual();
    showToast(t.downtimeDeleted, 'success');
}

async function deleteNCRRecord(id) {
    if (!hasPermission('canDeleteNCR')) { showToast('غير مسموح لك بحذف سجلات NCR', 'error'); return; }
    const t = translations[currentLanguage];
    const idx = ncrDB.findIndex(r => r.id === id);
    if (idx === -1) return;
    ncrDB.splice(idx, 1);
    await saveToServer('ncrDB', ncrDB);
    renderNCRList(); renderDashboard(); updateStats();
    showToast(t.ncrDeleted, 'success');
}

function updateStats() {
    document.getElementById('totalModels').textContent = db.length;
    let totalItems = 0; db.forEach(m => totalItems += m.items.length);
    document.getElementById('totalItems').textContent = totalItems;
    document.getElementById('totalWorkOrders').textContent = workOrdersDB.length;
    let woItems = 0; workOrdersDB.forEach(wo => woItems += wo.items.length);
    document.getElementById('workOrderItems').textContent = woItems;
    document.getElementById('totalProductionRecords').textContent = productionDB.length;
    let prodPcs = 0; productionDB.forEach(r => prodPcs += r.quantity);
    document.getElementById('totalProducedItems').textContent = prodPcs;
    document.getElementById('totalDowntimeRecords').textContent = downtimeDB.length;
    document.getElementById('totalNCRRecords').textContent = ncrDB.length;
    updateEmployeesStats();
}

function updateDataPathDisplay() {
    const span = document.getElementById('currentDataPath');
    if (span) span.textContent = 'Connected to server: ' + SERVER_URL;
}

function setupScrollToTop() {
    const scrollToTopBtn = document.getElementById('scrollToTop');
    window.addEventListener('scroll', () => {
        if (window.pageYOffset > 300) scrollToTopBtn.classList.remove('hidden');
        else scrollToTopBtn.classList.add('hidden');
    });
}

function scrollToTop() { window.scrollTo({ top: 0, behavior: 'smooth' }); }

function setWorkOrderFilter(filter) {
    currentWorkOrderFilter = filter;
    const inProgressBtn = document.getElementById('filterInProgressBtn');
    const finishedBtn = document.getElementById('filterFinishedBtn');
    [inProgressBtn, finishedBtn].forEach(btn => { if (btn) { btn.classList.remove('btn-primary'); btn.classList.add('btn-outline'); } });
    if (filter === 'inprogress') { inProgressBtn.classList.remove('btn-outline'); inProgressBtn.classList.add('btn-primary'); }
    else if (filter === 'finished') { finishedBtn.classList.remove('btn-outline'); finishedBtn.classList.add('btn-primary'); }
    renderWorkOrdersList();
}

// ====== INITIALIZATION ======
document.addEventListener('DOMContentLoaded', () => {
    initializeApp();
    setBackupScheduleInterval();
    setupScrollToTop();
    setupSaveOnClose();
});

async function initializeApp() {
    if (window.__appInitialized) return;
    window.__appInitialized = true;
    updateLanguageButtons();
    applyTranslations();
    applyLoginTranslations();
    updateRTL(currentLanguage);
    await loadData();
    const user = getCurrentUser();
    if (user) {
        applyPermissions();
        renderAll();
        showToast(translations[currentLanguage].welcome + ' ' + user.username, 'info');
    } else {
        document.getElementById('loginScreen').style.display = 'flex';
        document.querySelector('.fixed-header').style.display = 'none';
        document.querySelector('.sidebar').style.display = 'none';
        document.querySelector('.main-content').style.display = 'none';
        document.querySelector('.app-footer').style.display = 'none';
    }
    updateStats();
    renderModelsList(); renderWorkOrdersList(); renderProductionList();
    renderDowntimeList(); renderNCRList(); renderEmployeesList(); renderDashboard();
    populateTowerTypeDropdown();
    document.getElementById('productionDate').value = getYesterdayDateStr();
    document.getElementById('dailyReportFromDate').value = getLocalDateStr();
    document.getElementById('dailyReportToDate').value = getLocalDateStr();
    document.getElementById('ncrDate').value = getLocalDateStr();
    updateOperatorsDropdown();
    switchTab('dashboard');
    checkScheduledBackup();
    updateDataPathDisplay();
    setWorkOrderFilter('inprogress');
    const storedManual = localStorage.getItem('manualIdealRates');
    if (storedManual) window.manualIdealRates = JSON.parse(storedManual);
    else window.manualIdealRates = {};
    await updateIdealRatesFromActual();
    const balanceContainer = document.getElementById('balanceToggleContainer');
    if (balanceContainer) balanceContainer.classList.add('hidden');
    applyPermissionsToCurrentSection();
}
