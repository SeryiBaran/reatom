import { declareAtom as a } from '@reatom/core';
const myAtom0 = a("myAtom0", 'state', on => []);
const myAtom1 = a('notMyAtom', 'state', on => []);
const myAtom2 = a(['notMyAtom'], 'state', on => []);
const myAtom3 = declareAtom('state', on => []);