const express = require('express');
const Database = require('better-sqlite3');
const session = require('express-session');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const dotenv = require('dotenv');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const upload = multer({ dest: 'uploads/' });
app.use(express.json());
app.use(express.static('public'));
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax'
  }
}));

let db;

try {
  initializeDatabase();
} catch (error) {
  console.error('Failed to start server due to database initialization failure:', error.message);
  process.exit(1);
}

app.use((req, res, next) => {
  if (!db) {
    console.error('Database not initialized');
    return res.status(500).json({ error: '伺服器錯誤：資料庫未初始化，請檢查伺服器日誌' });
  }
  next();
});

function initializeDatabase() {
  try {
    db = new Database(':memory:');
    console.log('In-memory database connection established');

    // Create tables
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        nickname TEXT,
        created_at TEXT NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        food_category TEXT,
        food_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        import_date TEXT NOT NULL,
        vendor1 TEXT,
        vendor2 TEXT,
        vendor3 TEXT,
        expiration_date TEXT,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    db.exec(`
      CREATE TABLE consumption (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        food_category TEXT,
        food_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        consumption_date TEXT NOT NULL,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    db.exec(`
      CREATE TABLE foods (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        food_name TEXT NOT NULL UNIQUE,
        category TEXT,
        persistent INTEGER DEFAULT 0,
        persist_on_server INTEGER DEFAULT 0,
        import_session_id INTEGER,
        FOREIGN KEY (user_id) REFERENCES users(id),
        FOREIGN KEY (import_session_id) REFERENCES import_sessions(id)
      )
    `);

    db.exec(`
      CREATE TABLE import_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        session_name TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        persistent INTEGER DEFAULT 0,
        FOREIGN KEY (user_id) REFERENCES users(id)
      )
    `);

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization failed:', error.message);
    throw new Error(`Failed to initialize database: ${error.message}`);
  }
}

let ref = {
  "白吐司": { "食品分類": "麵包" }
};

let persistentCategoryCounts = {};

const loadFoods = (userId = 0) => {
  try {
    const foods = db.prepare('SELECT food_name, category FROM foods WHERE persist_on_server = 1 AND user_id = ?').all(userId);
    console.log(`Loaded ${foods.length} persistent foods for user ${userId}`);
    persistentCategoryCounts[userId] = {};
    foods.forEach(food => {
      ref[food.food_name] = { "食品分類": food.category || '未分類' };
      const category = food.category ? String(food.category).trim() : '未分類';
      persistentCategoryCounts[userId][category] = (persistentCategoryCounts[userId][category] || 0) + 1;
    });
    console.log(`Persistent category counts for user ${userId}:`, persistentCategoryCounts[userId]);
  } catch (error) {
    console.error(`Error loading foods for user ${userId}:`, error.message);
  }
};

loadFoods();

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: '請先登錄' });
  }
  next();
}

app.get('/inventory', requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT id, food_category, food_name, quantity, import_date, vendor1, vendor2, vendor3, expiration_date FROM inventory WHERE user_id = ?').all(req.session.userId);
    const data = [
      ['操作', '食品分類', '食品名稱', '數量', '進貨日期', '廠商1', '廠商2', '廠商3', '有效期限'],
      ...rows.map(row => [
        row.id,
        row.food_category || '',
        row.food_name,
        row.quantity,
        row.import_date,
        row.vendor1 || '',
        row.vendor2 || '',
        row.vendor3 || '',
        row.expiration_date || ''
      ])
    ];
    res.json(data);
  } catch (error) {
    console.error('Error fetching inventory:', error.message);
    res.status(500).json({ error: '無法獲取庫存資料：' + error.message });
  }
});

app.get('/consumption', requireAuth, (req, res) => {
  try {
    const rows = db.prepare('SELECT id, food_category, food_name, quantity, consumption_date FROM consumption WHERE user_id = ?').all(req.session.userId);
    const data = [
      ['操作', '食品分類', '食品名稱', '消耗數量', '消耗日期'],
      ...rows.map(row => [
        row.id,
        row.food_category || '',
        row.food_name,
        row.quantity,
        row.consumption_date
      ])
    ];
    res.json(data);
  } catch (error) {
    console.error('Error fetching consumption:', error.message);
    res.status(500).json({ error: '無法獲取消耗資料：' + error.message });
  }
});

app.get('/foods', requireAuth, (req, res) => {
  try {
    const foods = db.prepare('SELECT food_name, category FROM foods WHERE user_id = ?').all(req.session.userId);
    const formattedFoods = foods.map(food => ({ name: food.food_name, category: food.category }));
    console.log('[DEBUG] /foods returning:', formattedFoods);
    res.json(formattedFoods);
  } catch (error) {
    console.error('Error fetching foods:', error.message);
    res.status(500).json({ error: '無法獲取食品列表：' + error.message });
  }
});

app.get('/category-counts', requireAuth, (req, res) => {
  try {
    const allCategoryCounts = persistentCategoryCounts[req.session.userId] || {};
    const foods = db.prepare('SELECT category FROM foods WHERE category IS NOT NULL AND user_id = ?').all(req.session.userId);
    foods.forEach(food => {
      const category = food.category ? String(food.category).trim() : '未分類';
      allCategoryCounts[category] = (allCategoryCounts[category] || 0) + 1;
    });
    console.log('[DEBUG] Returning category counts:', allCategoryCounts);
    res.json(allCategoryCounts);
  } catch (error) {
    console.error('Error fetching category counts:', error.message);
    res.status(500).json({ error: '無法獲取食品分類計數：' + error.message });
  }
});

app.post('/add-inventory', requireAuth, async (req, res) => {
  const { date, food, quantity, vendor1, vendor2, vendor3, expiration } = req.body;
  if (!date || !food || !quantity || isNaN(quantity) || quantity <= 0) {
    return res.status(400).json({ error: '請提供所有必要欄位：進貨日期、食品名稱、數量' });
  }

  const dateRegex = /^\d{4}\/\d{2}\/\d{2}$/;
  if (!dateRegex.test(date) || (expiration && !dateRegex.test(expiration))) {
    return res.status(400).json({ error: '日期格式無效，應為 YYYY/MM/DD' });
  }

  try {
    const foodExists = db.prepare('SELECT category FROM foods WHERE food_name = ? AND user_id = ?').get(food, req.session.userId);
    if (!foodExists) {
      return res.status(400).json({ error: '食品不在資料庫中' });
    }

    const category = foodExists.category || null;
    const stmt = db.prepare(`
      INSERT INTO inventory (user_id, food_category, food_name, quantity, import_date, vendor1, vendor2, vendor3, expiration_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(req.session.userId, category, food, quantity, date, vendor1 || null, vendor2 || null, vendor3 || null, expiration || null);
    res.json({ message: '庫存記錄已新增', id: result.lastInsertRowid });
  } catch (error) {
    console.error('Add inventory error:', error.message);
    res.status(500).json({ error: '新增庫存記錄失敗：' + error.message });
  }
});

app.post('/add-consumption', requireAuth, async (req, res) => {
  const { food, quantity, date } = req.body;
  if (!food || !quantity || isNaN(quantity) || quantity <= 0 || !date) {
    return res.status(400).json({ error: '請提供所有必要欄位：食品名稱、消耗數量、消耗日期' });
  }

  const dateRegex = /^\d{4}\/\d{2}\/\d{2}$/;
  if (!dateRegex.test(date)) {
    return res.status(400).json({ error: '消耗日期格式無效，應為 YYYY/MM/DD' });
  }

  try {
    const foodExists = db.prepare('SELECT category FROM foods WHERE food_name = ? AND user_id = ?').get(food, req.session.userId);
    if (!foodExists) {
      return res.status(400).json({ error: '食品不在資料庫中' });
    }

    const totalInventory = db.prepare('SELECT SUM(quantity) as total FROM inventory WHERE food_name = ? AND user_id = ?').get(food, req.session.userId).total || 0;
    const totalConsumed = db.prepare('SELECT SUM(quantity) as total FROM consumption WHERE food_name = ? AND user_id = ?').get(food, req.session.userId).total || 0;
    if (totalInventory - totalConsumed < quantity) {
      return res.status(400).json({ error: `庫存不足，當前庫存：${totalInventory - totalConsumed}` });
    }

    const category = foodExists.category || null;
    const stmt = db.prepare(`
      INSERT INTO consumption (user_id, food_category, food_name, quantity, consumption_date)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run(req.session.userId, category, food, quantity, date);
    res.json({ message: '消耗記錄已新增', id: result.lastInsertRowid });
  } catch (error) {
    console.error('Add consumption error:', error.message);
    res.status(500).json({ error: '新增消耗記錄失敗：' + error.message });
  }
});

app.post('/edit-inventory', requireAuth, async (req, res) => {
  const { id, date, food, quantity, vendor1, vendor2, vendor3, expiration } = req.body;
  if (!id || !date || !food || !quantity || isNaN(quantity) || quantity <= 0) {
    return res.status(400).json({ error: '無效的輸入資料' });
  }

  const dateRegex = /^\d{4}\/\d{2}\/\d{2}$/;
  if (!dateRegex.test(date) || (expiration && !dateRegex.test(expiration))) {
    return res.status(400).json({ error: '日期格式無效，應為 YYYY/MM/DD' });
  }

  try {
    const foodExists = db.prepare('SELECT category FROM foods WHERE food_name = ? AND user_id = ?').get(food, req.session.userId);
    if (!foodExists) {
      return res.status(400).json({ error: '食品不在資料庫中' });
    }

    const category = foodExists.category || null;
    const update = db.prepare(`
      UPDATE inventory SET food_category = ?, food_name = ?, quantity = ?, import_date = ?,
      vendor1 = ?, vendor2 = ?, vendor3 = ?, expiration_date = ?
      WHERE id = ? AND user_id = ?
    `);
    const result = update.run(category, food, quantity, date, vendor1 || null, vendor2 || null, vendor3 || null, expiration || null, id, req.session.userId);
    if (result.changes === 0) {
      return res.status(404).json({ error: '找不到該庫存記錄' });
    }
    res.json({ message: '庫存記錄更新成功' });
  } catch (error) {
    console.error('Error updating inventory:', error.message);
    res.status(500).json({ error: '更新庫存記錄失敗：' + error.message });
  }
});

app.post('/delete-inventory', requireAuth, (req, res) => {
  const { id } = req.body;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: '無效的記錄 ID' });
  }

  try {
    const deleteStmt = db.prepare('DELETE FROM inventory WHERE id = ? AND user_id = ?');
    const result = deleteStmt.run(id, req.session.userId);
    if (result.changes === 0) {
      return res.status(404).json({ error: '找不到該庫存記錄' });
    }
    res.json({ message: '庫存記錄刪除成功' });
  } catch (error) {
    console.error('Delete inventory error:', error.message);
    res.status(500).json({ error: '刪除庫存記錄失敗：' + error.message });
  }
});

app.post('/delete-consumption', requireAuth, (req, res) => {
  const { id } = req.body;
  if (!id || isNaN(id)) {
    return res.status(400).json({ error: '無效的記錄 ID' });
  }

  try {
    const deleteStmt = db.prepare('DELETE FROM consumption WHERE id = ? AND user_id = ?');
    const result = deleteStmt.run(id, req.session.userId);
    if (result.changes === 0) {
      return res.status(404).json({ error: '找不到該消耗記錄' });
    }
    res.json({ message: '消耗記錄刪除成功' });
  } catch (error) {
    console.error('Delete consumption error:', error.message);
    res.status(500).json({ error: '刪除消耗記錄失敗：' + error.message });
  }
});

app.post('/import-foods', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) {
    console.error('No file uploaded');
    return res.status(400).json({ error: '請上傳一個 Excel 檔案' });
  }

  const persistent = req.body.persistent === 'true' ? 1 : 0;
  const persistOnServer = req.body.persist_on_server === 'true' ? 1 : 0;
  const sessionName = req.body.sessionName || `Import on ${new Date().toISOString()}`;

  console.log(`Importing with persistent=${persistent}, persistOnServer=${persistOnServer}, sessionName=${sessionName}`);

  let stream;
  try {
    const filePath = path.join(__dirname, req.file.path);
    console.log(`Reading file from path: ${filePath}`);

    const currentDate = new Date();
    const timestamp = currentDate.toISOString();
    const insertSession = db.prepare('INSERT INTO import_sessions (user_id, session_name, timestamp, persistent) VALUES (?, ?, ?, ?)');
    const sessionInfo = insertSession.run(req.session.userId, sessionName, timestamp, persistent);
    const sessionId = sessionInfo.lastInsertRowid;

    const workbook = new ExcelJS.Workbook();
    stream = fs.createReadStream(filePath);
    const worksheet = await workbook.xlsx.read(stream).then(() => {
      console.log('Excel file read successfully');
      return workbook.getWorksheet(1);
    });

    let headers;
    let headerRowFound = false;
    worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      if (rowNumber === 1) return;
      if (rowNumber === 2) {
        headers = row.values.slice(1).map(value => (value != null ? String(value).trim() : ''));
        console.log('Headers (raw):', headers);
        headerRowFound = true;
      }
      if (headerRowFound) return false;
    });

    if (!headerRowFound) {
      throw new Error('Could not find header row in Excel file');
    }

    const foodNameIndex = headers.findIndex(header => header && header.includes('樣品名稱'));
    if (foodNameIndex === -1) {
      console.error('Could not find "樣品名稱" column in headers');
      throw new Error('Excel 檔案中找不到 "樣品名稱" 欄位');
    }

    const categoryIndex = headers.findIndex(header => header && header.includes('食品分類'));
    console.log(`Found "食品分類" at index ${categoryIndex}`);

    const categoryCounts = {};
    if (categoryIndex !== -1) {
      worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
        if (rowNumber <= 2) return;
        const rowValues = row.values.slice(1);
        const category = rowValues[categoryIndex] ? String(rowValues[categoryIndex]).trim() : '未分類';
        categoryCounts[category] = (categoryCounts[category] || 0) + 1;
      });
      console.log('Category counts:', categoryCounts);
    }

    db.exec('DELETE FROM foods WHERE persistent = 0 AND persist_on_server = 0 AND user_id = ? AND import_session_id != ?', [req.session.userId, sessionId]);

    let importedCount = 0;
    let skippedRows = 0;

    const insertFood = db.prepare('INSERT OR REPLACE INTO foods (user_id, food_name, category, persistent, persist_on_server, import_session_id) VALUES (?, ?, ?, ?, ?, ?)');
    const transaction = db.transaction(() => {
      worksheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
        if (rowNumber <= 2) return;
        const rowValues = row.values.slice(1);
        const foodName = rowValues[foodNameIndex] ? String(rowValues[foodNameIndex]).trim() : null;
        if (!foodName) {
          console.log(`Skipping row ${rowNumber}: No valid food name`);
          skippedRows++;
          return;
        }

        const category = categoryIndex !== -1 && rowValues[categoryIndex] ? String(rowValues[categoryIndex]).trim() || null : null;
        try {
          insertFood.run(req.session.userId, foodName, category, persistent, persistOnServer, sessionId);
          importedCount++;
        } catch (error) {
          console.error(`Error inserting food ${foodName}:`, error.message);
          skippedRows++;
        }
      });
    });

    transaction();

    if (persistOnServer) {
      ref = { "白吐司": { "食品分類": "麵包" } };
      loadFoods(req.session.userId);
    }

    fs.unlinkSync(filePath);
    console.log('Deleted temporary file');

    res.json({
      message: `食品資料已成功匯入，新增 ${importedCount} 筆資料，跳過 ${skippedRows} 筆`,
      categoryCounts
    });
  } catch (error) {
    console.error('Import error:', error.message);
    res.status(500).json({ error: '匯入食品資料失敗：' + error.message });
  } finally {
    if (stream) stream.destroy();
    try {
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
        console.log('Temporary file deleted in finally block');
      }
    } catch (cleanupError) {
      console.error('Error during cleanup:', cleanupError.message);
    }
  }
});

app.get('/saved-imports', requireAuth, (req, res) => {
  try {
    const sessions = db.prepare('SELECT id, session_name, timestamp FROM import_sessions WHERE persistent = 1 AND user_id = ? ORDER BY timestamp DESC').all(req.session.userId);
    res.json(sessions.map(session => ({
      id: session.id,
      session_name: session.session_name,
      timestamp: session.timestamp
    })));
  } catch (error) {
    console.error('Error fetching saved imports:', error.message);
    res.status(500).json({ error: '無法獲取已保存的匯入資料：' + error.message });
  }
});

app.get('/persistent-imports', requireAuth, (req, res) => {
  try {
    const sessions = db.prepare('SELECT DISTINCT import_session_id FROM foods WHERE persist_on_server = 1 AND user_id = ?').all(req.session.userId);
    const sessionDetails = sessions.map(session => {
      const sessionInfo = db.prepare('SELECT id, session_name, timestamp FROM import_sessions WHERE id = ? AND user_id = ?').get(session.import_session_id, req.session.userId);
      return sessionInfo ? {
        id: sessionInfo.id,
        session_name: sessionInfo.session_name,
        timestamp: sessionInfo.timestamp
      } : null;
    }).filter(session => session !== null);
    res.json(sessionDetails);
  } catch (error) {
    console.error('Error fetching persistent imports:', error.message);
    res.status(500).json({ error: '無法獲取伺服器持久匯入資料：' + error.message });
  }
});

app.post('/load-saved-import', requireAuth, (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || isNaN(sessionId)) {
    return res.status(400).json({ error: '無效的匯入會話 ID' });
  }

  try {
    const session = db.prepare('SELECT * FROM import_sessions WHERE id = ? AND persistent = 1 AND user_id = ?').get(sessionId, req.session.userId);
    if (!session) {
      return res.status(404).json({ error: '找不到該匯入會話或該會話未被設為永久保存' });
    }

    db.exec('DELETE FROM foods WHERE persistent = 0 AND persist_on_server = 0 AND user_id = ?', [req.session.userId]);

    const existingRecords = db.prepare('SELECT * FROM foods WHERE import_session_id = ? AND (persistent = 1 OR persist_on_server = 1) AND user_id = ?').all(sessionId, req.session.userId);
    if (existingRecords.length === 0) {
      const records = db.prepare('SELECT food_name, category FROM foods WHERE import_session_id = ? AND user_id = ?').all(sessionId, req.session.userId);
      const insertFood = db.prepare('INSERT INTO foods (user_id, food_name, category, persistent, persist_on_server, import_session_id) VALUES (?, ?, ?, ?, ?, ?)');
      const transaction = db.transaction((recordsToInsert) => {
        for (const record of recordsToInsert) {
          insertFood.run(req.session.userId, record.food_name, record.category, 1, 0, sessionId);
        }
      });
      transaction(records);
    }

    ref = { "白吐司": { "食品分類": "麵包" } };
    loadFoods(req.session.userId);

    res.json({ message: `已成功載入保存的匯入資料：${session.session_name}` });
  } catch (error) {
    console.error('Error loading saved import:', error.message);
    res.status(500).json({ error: '載入保存的匯入資料失敗：' + error.message });
  }
});

app.post('/delete-saved-import', requireAuth, (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || isNaN(sessionId)) {
    return res.status(400).json({ error: '無效的匯入會話 ID' });
  }

  try {
    const session = db.prepare('SELECT * FROM import_sessions WHERE id = ? AND persistent = 1 AND user_id = ?').get(sessionId, req.session.userId);
    if (!session) {
      return res.status(404).json({ error: '找不到該匯入會話或該會話未被設為永久保存' });
    }

    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM foods WHERE import_session_id = ? AND user_id = ?').run(sessionId, req.session.userId);
      db.prepare('DELETE FROM import_sessions WHERE id = ? AND user_id = ?').run(sessionId, req.session.userId);
    });

    transaction();

    ref = { "白吐司": { "食品分類": "麵包" } };
    loadFoods(req.session.userId);

    res.json({ message: `已成功刪除保存的匯入資料：${session.session_name}` });
  } catch (error) {
    console.error('Error deleting saved import:', error.message);
    res.status(500).json({ error: '刪除保存的匯入資料失敗：' + error.message });
  }
});

app.post('/delete-persistent-imports', requireAuth, (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || isNaN(sessionId)) {
    return res.status(400).json({ error: '無效的匯入會話 ID' });
  }

  try {
    const session = db.prepare('SELECT * FROM import_sessions WHERE id = ? AND user_id = ?').get(sessionId, req.session.userId);
    if (!session) {
      return res.status(404).json({ error: '找不到該匯入會話' });
    }

    const transaction = db.transaction(() => {
      db.prepare('DELETE FROM foods WHERE import_session_id = ? AND persist_on_server = 1 AND user_id = ?').run(sessionId, req.session.userId);
      db.prepare('UPDATE import_sessions SET persistent = 0 WHERE id = ? AND user_id = ?').run(sessionId, req.session.userId);
      db.prepare('DELETE FROM import_sessions WHERE id = ? AND persistent = 0 AND user_id = ?').run(sessionId, req.session.userId);
    });

    transaction();

    ref = { "白吐司": { "食品分類": "麵包" } };
    loadFoods(req.session.userId);

    res.json({ message: `已成功刪除伺服器持久匯入資料：${session.session_name}` });
  } catch (error) {
    console.error('Error deleting persistent imports:', error.message);
    res.status(500).json({ error: '刪除伺服器持久匯入資料失敗：' + error.message });
  }
});

app.post('/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '請提供使用者名稱和密碼' });
  }

  const usernameRegex = /^[a-zA-Z0-9_]{3,20}$/;
  if (!usernameRegex.test(username)) {
    return res.status(400).json({ error: '使用者名稱必須為 3-20 個字元，僅限字母、數字或底線' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: '密碼必須至少 6 個字元' });
  }

  try {
    const existingUser = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
    if (existingUser) {
      return res.status(400).json({ error: '此使用者名稱已被使用' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const createdAt = new Date().toISOString();
    db.prepare('INSERT INTO users (username, password_hash, nickname, created_at) VALUES (?, ?, ?, ?)')
      .run(username, passwordHash, username, createdAt);

    res.json({ message: '註冊成功，請登錄' });
  } catch (error) {
    console.error('Registration error:', error.message);
    res.status(500).json({ error: '註冊失敗：' + error.message });
  }
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: '請提供使用者名稱和密碼' });
  }

  try {
    const user = db.prepare('SELECT id, username, password_hash, nickname FROM users WHERE username = ?').get(username);
    if (!user) {
      return res.status(401).json({ error: '無效的使用者名稱或密碼' });
    }

    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: '無效的使用者名稱或密碼' });
    }

    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ message: '登錄成功', nickname: user.nickname || user.username });
  } catch (error) {
    console.error('Login error:', error.message);
    res.status(500).json({ error: '登錄失敗：' + error.message });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error('Logout error:', err.message);
      return res.status(500).json({ error: '登出失敗' });
    }
    res.json({ message: '登出成功' });
  });
});

app.post('/change-password', requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  if (!oldPassword || !newPassword) {
    return res.status(400).json({ error: '請提供舊密碼和新密碼' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: '新密碼必須至少6個字元' });
  }

  try {
    const user = db.prepare('SELECT id, password_hash FROM users WHERE id = ?').get(req.session.userId);
    if (!user) {
      return res.status(404).json({ error: '使用者不存在' });
    }

    const match = await bcrypt.compare(oldPassword, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: '舊密碼不正確' });
    }

    const newPasswordHash = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(newPasswordHash, req.session.userId);

    req.session.regenerate(err => {
      if (err) {
        console.error('Session regeneration error:', err.message);
        return res.status(500).json({ error: '無法刷新會話' });
      }
      req.session.userId = user.id;
      req.session.username = db.prepare('SELECT username FROM users WHERE id = ?').get(user.id).username;
      res.json({ message: '密碼已成功更改，請重新登錄' });
    });
  } catch (error) {
    console.error('Change password error:', error.message);
    res.status(500).json({ error: '更改密碼失敗：' + error.message });
  }
});

app.post('/update-nickname', requireAuth, async (req, res) => {
  const { nickname } = req.body;
  if (!nickname) {
    return res.status(400).json({ error: '請提供新暱稱' });
  }

  const nicknameRegex = /^[a-zA-Z0-9_\u4e00-\u9fa5]{1,20}$/;
  if (!nicknameRegex.test(nickname)) {
    return res.status(400).json({ error: '暱稱必須為1-20個字元，僅限字母、數字、底線或中文' });
  }

  try {
    const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.session.userId);
    if (!user) {
      return res.status(404).json({ error: '使用者不存在' });
    }

    db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname, req.session.userId);
    res.json({ message: '暱稱已成功更新' });
  } catch (error) {
    console.error('Update nickname error:', error.message);
    res.status(500).json({ error: '更新暱稱失敗：' + error.message });
  }
});

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
