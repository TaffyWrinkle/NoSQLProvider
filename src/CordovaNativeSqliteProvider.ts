﻿/**
 * CordovaNativeSqliteProvider.ts
 * Author: David de Regt
 * Copyright: Microsoft 2015
 *
 * NoSqlProvider provider setup for cordova-native-sqlite, a cordova plugin backed by sqlite3.
 * Also works for react-native-sqlite-storage, since it's based on the same bindings, just make sure to pass in an instance
 * of the plugin into the constructor to be used, since window.sqlitePlugin won't exist.
 */

import _ = require('lodash');
import SyncTasks = require('synctasks');

import NoSqlProvider = require('./NoSqlProvider');
import SqlProviderBase = require('./SqlProviderBase');
import TransactionLockHelper, { TransactionToken } from './TransactionLockHelper';

// Extending interfaces that should be in lib.d.ts but aren't for some reason.
declare global {
    interface Window {
        sqlitePlugin: any;
    }
}

// declare enum SQLErrors {
//     UNKNOWN_ERR = 0,
//     DATABASE_ERR = 1,
//     VERSION_ERR = 2,
//     TOO_LARGE_ERR = 3,
//     QUOTA_ERR = 4,
//     SYNTAX_ERR = 5,
//     CONSTRAINT_ERR = 6,
//     TIMEOUT_ERR = 7
// }

interface SQLError {
    code: number;
    message: string;
}

interface SQLStatementCallback {
    (transaction: SQLTransaction, resultSet: SqlProviderBase.SQLResultSet): void;
}

interface SQLStatementErrorCallback {
    (transaction: SQLTransaction, error: SQLError): void;
}

interface SQLTransaction {
    executeSql(sqlStatement: string, args?: any[], callback?: SQLStatementCallback, errorCallback?: SQLStatementErrorCallback): void;
}

export type SqliteSuccessCallback = () => void;
export type SqliteErrorCallback = (e: Error) => void;

export interface SqlitePluginDbOptionalParams {
    createFromLocation?: number;
    androidDatabaseImplementation?: number;
    // Database encryption pass phrase
    key?: string;
}

export interface SqlitePluginDbParams extends SqlitePluginDbOptionalParams {
    name: string;
    location: number;
}

export interface CordovaTransactionCallback {
    (transaction: CordovaTransaction): void;
}

export interface SqliteDatabase {
    openDBs: string[];
    transaction(callback?: CordovaTransactionCallback, errorCallback?: SqlProviderBase.SQLTransactionErrorCallback,
        successCallback?: SqlProviderBase.SQLVoidCallback): void;
    readTransaction(callback?: CordovaTransactionCallback, errorCallback?: SqlProviderBase.SQLTransactionErrorCallback,
        successCallback?: SqlProviderBase.SQLVoidCallback): void;
    open(success: SqliteSuccessCallback, error: SqliteErrorCallback): void;
    close(success: SqliteSuccessCallback, error: SqliteErrorCallback): void;
    executeSql(statement: string, params?: any[], success?: SqlProviderBase.SQLStatementCallback,
        error?: SqlProviderBase.SQLStatementErrorCallback): void;
}

export interface SqlitePlugin {
    openDatabase(dbInfo: SqlitePluginDbParams, success?: SqliteSuccessCallback, error?: SqliteErrorCallback): SqliteDatabase;
    deleteDatabase(dbInfo: SqlitePluginDbParams, success?: SqliteSuccessCallback, error?: SqliteErrorCallback): void;
    sqliteFeatures: { isSQLitePlugin: boolean };
}

export interface CordovaTransaction extends SqlProviderBase.SQLTransaction {
    abort(err?: any): void;
}

export class CordovaNativeSqliteProvider extends SqlProviderBase.SqlProviderBase {
    private _lockHelper: TransactionLockHelper|undefined;

    // You can use the openOptions object to pass extra optional parameters like androidDatabaseImplementation to the open command
    constructor(private _plugin: SqlitePlugin = window.sqlitePlugin, private _openOptions: SqlitePluginDbOptionalParams = {}) {
        super(true);
    }

    private _db: SqliteDatabase|undefined;

    private _dbParams: SqlitePluginDbParams|undefined;
    private _closingDefer: SyncTasks.Deferred<void>|undefined;

    open(dbName: string, schema: NoSqlProvider.DbSchema, wipeIfExists: boolean, verbose: boolean): SyncTasks.Promise<void> {
        super.open(dbName, schema, wipeIfExists, verbose);
        this._lockHelper = new TransactionLockHelper(schema, true);

        if (!this._plugin || !this._plugin.openDatabase) {
            return SyncTasks.Rejected<void>('No support for native sqlite in this browser');
        }

        if (typeof (navigator) !== 'undefined' && navigator.userAgent && navigator.userAgent.indexOf('Mobile Crosswalk') !== -1) {
            return SyncTasks.Rejected<void>('Android NativeSqlite is broken, skipping');
        }

        this._dbParams = _.extend<SqlitePluginDbParams>({
            name: dbName + '.db',
            location: 2
        }, this._openOptions);

        const task = SyncTasks.Defer<void>();
        this._db = this._plugin.openDatabase(this._dbParams, () => {
            task.resolve(void 0);
        }, (err: any) => {
            task.reject('Couldn\'t open database: ' + dbName + ', error: ' + JSON.stringify(err));
        });

        return task.promise().then(() => {
            return this._ourVersionChecker(wipeIfExists);
        }).catch(err => {
            return SyncTasks.Rejected<void>('Version check failure. Couldn\'t open database: ' + dbName +
                ', error: ' + JSON.stringify(err));
        });
    }

    close(): SyncTasks.Promise<void> {
        if (!this._db) {
            return SyncTasks.Rejected<void>('Database already closed');
        }

        return this._lockHelper!!!.closeWhenPossible().then(() => {
            let def = SyncTasks.Defer<void>();
            this._db!!!.close(() => {
                this._db = undefined;
                def.resolve(void 0);
            }, (err: any) => {
                def.reject(err);
            });
            return def.promise();
        });
    }
    
    protected _deleteDatabaseInternal(): SyncTasks.Promise<void> {
        if (!this._plugin || !this._plugin.deleteDatabase) {
            return SyncTasks.Rejected<void>('No support for deleting');
        }
        let task = SyncTasks.Defer<void>();
        this._plugin.deleteDatabase(this._dbParams!!!, () => {
            task.resolve(void 0);
        }, err => {
            task.reject('Couldn\'t delete the database ' + this._dbName + ', error: ' + JSON.stringify(err));
        });
        return task.promise();
    }

    openTransaction(storeNames: string[], writeNeeded: boolean): SyncTasks.Promise<SqlProviderBase.SqlTransaction> {
        if (!this._db) {
            return SyncTasks.Rejected('Can\'t openTransation, Database closed');
        }

        if (this._closingDefer) {
            return SyncTasks.Rejected('Currently closing provider -- rejecting transaction open');
        }

        return this._lockHelper!!!.openTransaction(storeNames, writeNeeded).then(transToken => {
            const deferred = SyncTasks.Defer<SqlProviderBase.SqlTransaction>();

            let ourTrans: SqlProviderBase.SqliteSqlTransaction;
            (writeNeeded ? this._db!!!.transaction : this._db!!!.readTransaction).call(this._db, (trans: CordovaTransaction) => {
                ourTrans = new CordovaNativeSqliteTransaction(trans, this._lockHelper!!!, transToken, this._schema!!!, this._verbose!!!,
                    999, this._supportsFTS3);
                deferred.resolve(ourTrans);
            }, (err: SQLError) => {
                if (ourTrans) {
                    ourTrans.internal_markTransactionClosed();
                    this._lockHelper!!!.transactionFailed(transToken, 'CordovaNativeSqliteTransaction Error: ' + err.message);
                } else {
                    // We need to reject the transaction directly only in cases when it never finished creating.
                    deferred.reject(err);
                }
            }, () => {
                ourTrans.internal_markTransactionClosed();
                this._lockHelper!!!.transactionComplete(transToken);
            });
            return deferred.promise();
        });
    }
}

class CordovaNativeSqliteTransaction extends SqlProviderBase.SqliteSqlTransaction {
    constructor(trans: CordovaTransaction,
                protected _lockHelper: TransactionLockHelper,
                protected _transToken: TransactionToken,
                schema: NoSqlProvider.DbSchema,
                verbose: boolean,
                maxVariables: number,
                supportsFTS3: boolean) {
        super(trans, schema, verbose, maxVariables, supportsFTS3);
    }

    getCompletionPromise(): SyncTasks.Promise<void> {
        return this._transToken.completionPromise;
    }

    abort(): void {
        // This will wrap through to the transaction error path above.
        (this._trans as CordovaTransaction).abort('Manually Aborted');
    }

    getErrorHandlerReturnValue(): boolean {
        // react-native-sqlite-storage throws on anything but false
        return false;
    }

    protected _requiresUnicodeReplacement(): boolean {
        // TODO dadere (#333863): Possibly limit this to just iOS, since Android seems to handle it properly
        return true;
    }
}
