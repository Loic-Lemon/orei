import { fixtures } from '../src/fixtures';
import { DRAFTS_KEY, WORKSPACE_VERSION, WORKSPACE_VERSION_KEY } from '../src/workspace';

/**
 * Seeds the shipped sample workspace explicitly. The version marker distinguishes an
 * intentional fixture workspace from the untouched, unversioned one a legacy launch
 * may migrate to a clean Untitled 1.
 */
export function seedFixtures(active='small'){
  localStorage.setItem(DRAFTS_KEY,JSON.stringify({documents:fixtures,active}));
  localStorage.setItem(WORKSPACE_VERSION_KEY,WORKSPACE_VERSION);
}

/** Seeds samples only when the test itself has not installed a recovery workspace. */
export function ensureFixtures(active='small'){
  if(localStorage.getItem(DRAFTS_KEY)===null)seedFixtures(active);
}

export function seedDocument(name:string,document:{source:string;css:string;assets:Record<string,string>},active=name){
  localStorage.setItem(DRAFTS_KEY,JSON.stringify({documents:{[name]:document},active}));
  localStorage.setItem(WORKSPACE_VERSION_KEY,WORKSPACE_VERSION);
}
