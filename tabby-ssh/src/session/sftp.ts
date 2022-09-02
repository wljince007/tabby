import * as C from 'constants'
import * as path from 'path'
import * as fs from 'fs/promises';
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
    isFile: boolean
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


class LocalFileHandle {
    private file: fs.FileHandle
    private buffer: Buffer

    constructor (
        private filePath: string,
        private openFlags: string,
    ) {
        this.buffer = Buffer.alloc(256 * 1024)
    }

    async open (): Promise<void> {        
        this.file = await fs.open(this.filePath, this.openFlags)
    }

    async read (): Promise<Buffer> {
        const result = await this.file.read(this.buffer, 0, this.buffer.length, null)
        return this.buffer.slice(0, result.bytesRead)
    }

    async write (buffer: Buffer): Promise<void> {
        let pos = 0
        while (pos < buffer.length) {
            const result = await this.file.write(buffer, pos, buffer.length - pos, null)
            pos += result.bytesWritten
        }
    }

    close (): void {
        this.file.close()
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
            isFile: stats.isFile(),
            isSymlink: stats.isSymbolicLink(),
            mode: stats.mode,
            size: stats.size,
            modified: new Date(stats.mtime * 1000),
        }
    }

    async lstat (p: string): Promise<SFTPFile> {
        this.logger.debug('lstat', p)
        const stats = await wrapPromise(this.zone, promisify<Stats>(f => this.sftp.lstat(p, f))())
        return {
            name: posixPath.basename(p),
            fullPath: p,
            isDirectory: stats.isDirectory(),
            isFile: stats.isFile(),
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

    async uploadOneFile (localpath: string, remotepath: string,UIShower: FileUpload,UIrootpath: string): Promise<void> {
        this.logger.info(`uploadOneFile from ${localpath} to ${remotepath}`)
        const tempPath = remotepath + '.tabby-upload'
        try {            
            UIShower.updateUiStr("uploading : " + localpath.replace(path.dirname(UIrootpath) + "/",""))
            const localHandle = new LocalFileHandle(localpath, 'r')
            const handle = await this.open(tempPath, 'w')
            await localHandle.open()
            while (true) {
                const chunk = await localHandle.read()
                if (!chunk.length) {
                    break
                }
                await handle.write(chunk)
                UIShower.increaseCompletedBtyes(chunk.length)
            }
            handle.close()
            try {
                await this.unlink(remotepath)
            } catch { }
            await this.rename(tempPath, remotepath)
            // UIShower.close()
        } catch (e) {
            // UIShower.cancel()
            this.unlink(tempPath)
            throw e
        }
    }

    async uploadDirectoryImpl(localpath: string, remotepath: string,UIShower: FileUpload,UIrootpath: string): Promise<void> {
        this.logger.info(`uploadDirectoryImpl from ${localpath} to ${remotepath}`)
        let localpathstates = fsSync.statSync(localpath);
        if (localpathstates.isDirectory()){
            this.sftp.mkdir(remotepath, (err: any) => {})
            let files = fsSync.readdirSync(localpath);
            for (const item in files) {
                const localitemfullpath = localpath+'/'+files[item]
                const remoteitemfullpath = remotepath+'/'+files[item]
                let states = fsSync.statSync(localitemfullpath);
                if(states.isDirectory()) {
                    await this.uploadDirectoryImpl(localitemfullpath, remoteitemfullpath, UIShower, UIrootpath)
                } else if (states.isFile()) {
                    await this.uploadOneFile(localitemfullpath, remoteitemfullpath, UIShower, UIrootpath)
                // } else if (states.isSymbolicLink()){
                //     const linktopath = fsSync.readlinkSync(localitemfullpath)
                //     this.logger.debug(`${localitemfullpath} link to ${linktopath}`)
                //     //sftp 和　scp都不处理软连接文件
                //     this.logger.warn(`upload "${localitemfullpath}": not a regular file`)
                } else {
                    this.logger.warn(`upload "${localitemfullpath}": not a regular file`)
                }
            }
        } else if (localpathstates.isSymbolicLink()){

        } else {
            await this.uploadOneFile(localpath, remotepath, UIShower, UIrootpath)
        }
    }

    async uploadDirectory (ftpFilePath: string, UIShower: FileUpload): Promise<void> {
        try {
            const localpath = UIShower.getFilePath()
            this.logger.info(`uploadDirectory from ${localpath} to ${ftpFilePath}`)
            await this.uploadDirectoryImpl(localpath,ftpFilePath,UIShower, localpath)
            UIShower.close()
        } catch (e) {
            UIShower.cancel()
            throw e
        }
    }

    async upload (ftpFilePath: string, transfer: FileUpload): Promise<void> {
        this.logger.info('Uploading into', ftpFilePath)
        const tempPath = ftpFilePath + '.tabby-upload'
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
                await this.unlink(ftpFilePath)
            } catch { }
            await this.rename(tempPath, ftpFilePath)
            transfer.close()
        } catch (e) {
            transfer.cancel()
            this.unlink(tempPath)
            throw e
        }
    }
   
    async downloadOneFile (remotepath: string, localpath: string, UIShower: FileDownload,UIrootpath: string): Promise<void> {
        this.logger.info(`downloadOneFile from ${remotepath} to ${localpath}`)
        
        try {
            UIShower.updateUiStr("downloading : " + localpath.replace(path.dirname(UIrootpath) + "/",""))
            const remoteHandle = await this.open(remotepath, 'r')
            const localHandle = new LocalFileHandle(localpath, 'w')
            await localHandle.open()
            while (true) {
                const chunk = await remoteHandle.read()
                if (!chunk.length) {
                    break
                }
                localHandle.write(chunk)
                await UIShower.increaseCompletedBtyes(chunk.length)
            }
            // UIShower.close()
            remoteHandle.close()
            localHandle.close()
        } catch (e) {
            // UIShower.cancel()
            throw e
        }
    }

    async downloadDirectoryImpl(remotepath: string, localpath: string, UIShower: FileDownload, UIrootpath: string): Promise<void> {
        this.logger.info(`downloadDirectoryImpl from ${remotepath} to ${localpath}`)
        const remotepathstat = await this.lstat(remotepath)
        if (remotepathstat.isDirectory){
            fsSync.mkdir(localpath,remotepathstat.mode, (err: any) => {})
            const entries = await wrapPromise(this.zone, promisify<FileEntry[]>(f => this.sftp.readdir(remotepath, f))())
            for (let index = 0; index < entries.length; index++) {
                const filename = entries[index].filename;
                const localitemfullpath = localpath+'/'+filename
                const remoteitemfullpath = remotepath+'/'+filename
                const remoteitemfullpathstat = await this.lstat(remoteitemfullpath)
                if(remoteitemfullpathstat.isDirectory) {
                    await this.downloadDirectoryImpl(remoteitemfullpath, localitemfullpath,UIShower,localpath)
                } else if (remoteitemfullpathstat.isFile) {
                    await this.downloadOneFile(remoteitemfullpath, localitemfullpath,UIShower,UIrootpath)
                // } else if (remoteitemfullpathstat.isSymlink){
                //     //sftp 和　scp都不处理软连接文件
                //     const linktopath = await wrapPromise(this.zone, promisify<string>(f => this.sftp.readlink(remoteitemfullpath, f))())
                //     this.logger.debug(`${remoteitemfullpath} link to ${linktopath}`)
                //     this.logger.warn(`download "${remoteitemfullpath}": not a regular file`)
                } else {
                    this.logger.warn(`download "${remoteitemfullpath}": not a regular file`)
                }
            }
        } else if (remotepathstat.isSymlink){

        } else {
            await this.downloadOneFile(remotepath, localpath,UIShower,UIrootpath)
        }
    }

    async downloadDirectory(remotepath: string, UIShower: FileDownload): Promise<void> {
        try {
            const localpath = UIShower.getFilePath()
            this.logger.info(`downloadDirectory from ${remotepath} to ${localpath}`)
            await this.downloadDirectoryImpl(remotepath,localpath,UIShower,localpath)
            UIShower.close()
        } catch (e) {
            UIShower.cancel()
            throw e
        }
    }


    async download (ftpFilePath: string, transfer: FileDownload): Promise<void> {
        this.logger.info('Downloading', ftpFilePath)
        try {
            const handle = await this.open(ftpFilePath, 'r')
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
            isFile: (entry.attrs.mode & C.S_IFDIR) === C.S_IFREG,
            isSymlink: (entry.attrs.mode & C.S_IFLNK) === C.S_IFLNK,
            mode: entry.attrs.mode,
            size: entry.attrs.size,
            modified: new Date(entry.attrs.mtime * 1000),
        }
    }
}
