const hasOwn = {}.hasOwnProperty;

interface ClassArray extends Array<ClassValue> { }
interface ClassDictionary {
    [id: string]: boolean | undefined;
}
declare type ClassValue = undefined | string | number | ClassDictionary | ClassArray;

function parseValue(arg: ClassValue) {
    if (typeof arg === 'string') {
        return arg;
    }
    if (typeof arg !== 'object') {
        return '';
    }
    if (Array.isArray(arg)) {
        return classNames(...arg);
    }
    if (arg.toString !== Object.prototype.toString) {
        return arg.toString();
    }
    let out = '';
    for (const key in arg) {
        if (hasOwn.call(arg, key) && arg[key]) {
            out = appendClass(out, key);
        }
    }
    return out;
}

function appendClass(value: string, newClass: string | null) {
    if (!newClass) {
        return value;
    }
    return value ? (value + ' ' + newClass) : newClass;
}

export function classNames(...values: ClassValue[]) {
    let out = "";
    for (let i = 0; i < values.length; i++) {
        const arg = values[i];
        if (arg) {
            out = appendClass(out, parseValue(arg));
        }
    }
    return out;
}
