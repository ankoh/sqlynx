const DB_NAME = 'sqlynx.salesforce';

// https://dev.to/esponges/indexeddb-your-offline-and-serverless-db-in-your-browser-with-react-3hm7

enum Stores {
    Users = 'users',
}

let request: IDBOpenDBRequest;
let db: IDBDatabase;
let version = 1;

interface User {
    id: string;
    name: string;
    email: string;
}

function initDB(): Promise<boolean> {
    return new Promise(resolve => {
        request = indexedDB.open(DB_NAME);

        request.onupgradeneeded = () => {
            db = request.result;
            if (!db.objectStoreNames.contains(Stores.Users)) {
                db.createObjectStore(Stores.Users, { keyPath: 'id' });
            }
        };

        request.onsuccess = () => {
            db = request.result;
            version = db.version;
            resolve(true);
        };

        request.onerror = () => {
            resolve(false);
        };
    });
}
