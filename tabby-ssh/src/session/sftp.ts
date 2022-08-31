import * as C from 'constants'
// import * as path from 'path';
// import * as fs from 'fs/promises';
// import * as os from 'os';
import * as fsSync from 'fs';
// eslint-disable-next-line @typescript-eslint/no-duplicate-imports, no-duplicate-imports
import { Subject, Observable } from 'rxjs'
import { posix as posixPath } from 'path'
import { Injector, NgZone } from '@angular/core'
import { FileDownload, FileUpload, Logger, LogService, wrapPromise } from 'tabby-core'
import { SFTPWrapper } from 'ssh2'
import { promisify } from 'util'

import type { FileEntry, Stats } from 'ssh2-streams'

export interface SFTPFile {
    name: string
    fullPath: string
    isDirectory: boolean
    isSymlink: boolean
    mode: number
    size: number
    modified: Date
}

export class SFTPFileHandle {
    position = 0

    constructor (
        private sftp: SFTPWrapper,
        private handle: Buffer,
        private zone: NgZone,
    ) { }

    read (): Promise<Buffer> {
        const buffer = Buffer.alloc(256 * 1024)
        return wrapPromise(this.zone, new Promise((resolve, reject) => {
            while (true) {
                const wait = this.sftp.read(this.handle, buffer, 0, buffer.length, this.position, (err, read) => {
                    if (err) {
                        reject(err)
                        return
                    }
                    this.position += read
                    resolve(buffer.slice(0, read))
                })
                if (!wait) {
                    break
                }
            }
        }))
    }

    write (chunk: Buffer): Promise<void> {
        return wrapPromise(this.zone, new Promise<void>((resolve, reject) => {
            while (true) {
                const wait = this.sftp.write(this.handle, chunk, 0, chunk.length, this.position, err => {
                    if (err) {
                        reject(err)
                        return
                    }
                    this.position += chunk.length
                    resolve()
                })
                if (!wait) {
                    break
                }
            }
        }))
    }

    close (): Promise<void> {
        return wrapPromise(this.zone, promisify(this.sftp.close.bind(this.sftp))(this.handle))
    }
}

export class SFTPSession {
    get closed$ (): Observable<void> { return this.closed }
    private closed = new Subject<void>()
    private zone: NgZone
    private logger: Logger

    constructor (private sftp: SFTPWrapper, injector: Injector) {
        this.zone = injector.get(NgZone)
        this.logger = injector.get(LogService).create('sftp')
        sftp.on('close', () => {
            this.closed.next()
            this.closed.complete()
        })
    }

    async readdir (p: string): Promise<SFTPFile[]> {
        this.logger.debug('readdir', p)
        const entries = await wrapPromise(this.zone, promisify<FileEntry[]>(f => this.sftp.readdir(p, f))())
        return entries.map(entry => this._makeFile(
            posixPath.join(p, entry.filename), entry,
        ))
    }

    readlink (p: string): Promise<string> {
        this.logger.debug('readlink', p)
        return wrapPromise(this.zone, promisify<string>(f => this.sftp.readlink(p, f))())
    }

    async stat (p: string): Promise<SFTPFile> {
        this.logger.debug('stat', p)
        const stats = await wrapPromise(this.zone, promisify<Stats>(f => this.sftp.stat(p, f))())
        return {
            name: posixPath.basename(p),
            fullPath: p,
            isDirectory: stats.isDirectory(),
            isSymlink: stats.isSymbolicLink(),
            mode: stats.mode,
            size: stats.size,
            modified: new Date(stats.mtime * 1000),
        }
    }

    async open (p: string, mode: string): Promise<SFTPFileHandle> {
        this.logger.debug('open', p)
        const handle = await wrapPromise(this.zone, promisify<Buffer>(f => this.sftp.open(p, mode, f))())
        return new SFTPFileHandle(this.sftp, handle, this.zone)
    }

    async rmdir (p: string): Promise<void> {
        this.logger.debug('rmdir', p)
        await promisify((f: any) => this.sftp.rmdir(p, f))()
    }

    async mkdir (p: string): Promise<void> {
        this.logger.debug('mkdir', p)
        await promisify((f: any) => this.sftp.mkdir(p, f))()
    }

    async rename (oldPath: string, newPath: string): Promise<void> {
        this.logger.debug('rename', oldPath, newPath)
        await promisify((f: any) => this.sftp.rename(oldPath, newPath, f))()
    }

    async unlink (p: string): Promise<void> {
        this.logger.debug('unlink', p)
        await promisify((f: any) => this.sftp.unlink(p, f))()
    }

    async uploadFile (localpath: string, remotepath: string): Promise<void> {
        this.logger.info(`uploadFile from ${localpath} to ${remotepath}`)
        this.sftp.fastPut(localpath,remotepath,
            (err: any) => {
                if (err) {
                    this.logger.error(`upload from ${localpath} to ${remotepath} err:${err}`)
                    throw err
                }else {
                    this.logger.info(`upload from ${localpath} to ${remotepath} succ!`)
                }
                })
    }

    async uploadFileOrDirectory(localpath: string, remotepath: string): Promise<void> {
        this.logger.info(`uploadFileOrDirectory from ${localpath} to ${remotepath}`)
        let localpathstates = fsSync.statSync(localpath);
        if (localpathstates.isDirectory()){
            this.sftp.mkdir(remotepath, (err: any) => {})
            let files = fsSync.readdirSync(localpath);
            for (const item in files) {
                const localitemfullpath = localpath+'/'+files[item]
                const remoteitemfullpath = remotepath+'/'+files[item]
                let states = fsSync.statSync(localitemfullpath);
                if(states.isDirectory()) {
                    await this.uploadFileOrDirectory(localitemfullpath, remoteitemfullpath)
                }else {
                    await this.uploadFile(localitemfullpath, remoteitemfullpath)
                }
            }
        }else {
            await this.uploadFile(localpath, remotepath)
        }
    }

    async downloadFile (remotepath: string, localpath: string): Promise<void> {
        this.logger.info(`downloadFile from ${remotepath} to ${localpath}`)
        this.sftp.fastGet(remotepath, localpath,
            (err: any) => {
                if (err) {
                    this.logger.error(`downloadFile from ${remotepath} to ${localpath} err:${err}`)
                    throw err
                }else {
                    this.logger.info(`downloadFile from ${remotepath} to ${localpath} succ!`)
                }
                })
    }

    async downloadFileOrDirectory(remotepath: string, localpath: string): Promise<void> {
        this.logger.debug('readdir', remotepath)
        const remotepathstat = await this.stat(remotepath)
        if (remotepathstat.isDirectory){
            fsSync.mkdir(localpath,remotepathstat.mode, (err: any) => {})
            const entries = await wrapPromise(this.zone, promisify<FileEntry[]>(f => this.sftp.readdir(remotepath, f))())
            for (let index = 0; index < entries.length; index++) {
                const filename = entries[index].filename;
                const localitemfullpath = localpath+'/'+filename
                const remoteitemfullpath = remotepath+'/'+filename
                const remoteitemfullpathstat = await this.stat(remoteitemfullpath)
                if(remoteitemfullpathstat.isDirectory) {
                    await this.downloadFileOrDirectory(remoteitemfullpath, localitemfullpath)
                }else {
                    await this.downloadFile(remoteitemfullpath, localitemfullpath)
                }
            }
        }else {
            await this.downloadFile(remotepath, localpath)
        }
    }

    async upload (path: string, transfer: FileUpload): Promise<void> {
        this.logger.info('Uploading into', path)
        // let localPath = transfer.getFilePath()
        // this.uploadFileOrDirectory(localPath,path)
        
        const tempPath = path + '.tabby-upload'
        try {
            const handle = await this.open(tempPath, 'w')
            while (true) {
                const chunk = await transfer.read()
                if (!chunk.length) {
                    break
                }
                await handle.write(chunk)
            }
            handle.close()
            try {
                await this.unlink(path)
            } catch { }
            await this.rename(tempPath, path)
            transfer.close()
        } catch (e) {
            transfer.cancel()
            this.unlink(tempPath)
            throw e
        }
    }
    
    async download (path: string, transfer: FileDownload): Promise<void> {
        this.logger.info('Downloading', path)
        // let localpath = transfer.getFilePath()
        // this.downloadFile(path, localpath)
        try {
            const handle = await this.open(path, 'r')
            while (true) {
                const chunk = await handle.read()
                if (!chunk.length) {
                    break
                }
                await transfer.write(chunk)
            }
            transfer.close()
            handle.close()
        } catch (e) {
            transfer.cancel()
            throw e
        }
    }

    private _makeFile (p: string, entry: FileEntry): SFTPFile {
        return {
            fullPath: p,
            name: posixPath.basename(p),
            isDirectory: (entry.attrs.mode & C.S_IFDIR) === C.S_IFDIR,
            isSymlink: (entry.attrs.mode & C.S_IFLNK) === C.S_IFLNK,
            mode: entry.attrs.mode,
            size: entry.attrs.size,
            modified: new Date(entry.attrs.mtime * 1000),
        }
    }
}
