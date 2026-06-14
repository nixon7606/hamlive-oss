export class HttpClient {
    constructor(_label: any, url: any, config?: {});
    get label(): any;
    get url(): any;
    index(options?: {
        followRedirs: boolean;
    }): Promise<any>;
    show(id: any): Promise<any>;
    update(data: any, id: any): Promise<any>;
    create(data: any, id: any): Promise<any>;
    delete(id: any): Promise<any>;
    #private;
}
export class FavClient {
    constructor(_uxDelay: any, _mod: any);
    populateCache(): Promise<true | undefined>;
    get cache(): any;
    get clicked(): boolean;
    handler(event: any): Promise<void>;
    paintFromCacheData(): Promise<void>;
    paintFromServerData(): Promise<void>;
    interval(i: any): Promise<void>;
    #private;
}
export class FormState {
    constructor(_label: any, _mode: any);
    mesg(type: any, mesg?: string): {
        mesg: string;
        color: string;
    };
    set mode(newMode: any);
    get mode(): any;
    get label(): any;
    #private;
}
export class Looper {
    constructor({ label, refresh, exec }: {
        label: any;
        refresh: any;
        exec: any;
    });
    run(): Promise<any>;
    runOnce(): Promise<void>;
    get i(): number;
    get refresh(): number;
    #private;
}
//# sourceMappingURL=old__clientUtils.d.ts.map