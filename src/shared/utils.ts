import { Response } from 'node-fetch';
import m3u8 from '@eyevinn/m3u8';
import { M3U, ServiceError } from './types';
import clone from 'clone';
import { ALBEvent, ALBResult, ALBEventQueryStringParameters } from 'aws-lambda';
import { ReadStream } from 'fs';
import { IncomingHttpHeaders } from 'http';
import path from 'path';
import { CorruptorConfigMap } from '../manifests/utils/configs';

import { addSSMUrlParametersToUrl } from './aws.utils';
require('dotenv').config();

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { version } = require('../../package.json');

export const handleOptionsRequest = async (): Promise<ALBResult> => {
  return {
    statusCode: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Origin',
      'Access-Control-Max-Age': '86400'
    }
  };
};

export const generateErrorResponse = (
  err: ServiceError
): Promise<ALBResult> => {
  const response: ALBResult = {
    statusCode: err.status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Origin'
    }
  };
  response.body = JSON.stringify({ reason: err.message });

  return Promise.resolve(response);
};

export const generateHeartbeatResponse = (): Promise<ALBResult> => {
  const response: ALBResult = {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Origin'
    }
  };
  response.body = JSON.stringify({ message: 'OK! 💚', version });

  return Promise.resolve(response);
};

export const isValidUrl = (string) => {
  if (!string) return false;
  try {
    const url = decodeURIComponent(string);
    new URL(url); // eslint-disable-line

    return true;
  } catch (_) {
    return false;
  }
};

export async function composeALBEvent(
  httpMethod: string,
  url: string,
  incomingHeaders: IncomingHttpHeaders
): Promise<ALBEvent> {
  // Create ALBEvent from Fastify Request...

  if (AppSettings.loadUrlParametersFromAwsSSM) {
    url = await addSSMUrlParametersToUrl(url);
  }

  const [path, ...queryString] = url.split('?');
  const queryStringParameters = Object.fromEntries(
    new URLSearchParams(decodeURIComponent(queryString.join('?')))
  );

  const requestContext = { elb: { targetGroupArn: '' } };
  const headers: Record<string, string> = {};

  // IncomingHttpHeaders type is Record<string, string|string[]> because set-cookie is an array
  for (const [name, value] of Object.entries(incomingHeaders)) {
    if (typeof value === 'string') {
      headers[name] = value;
    }
  }

  return {
    requestContext,
    path,
    httpMethod,
    headers,
    queryStringParameters,
    body: '',
    isBase64Encoded: false
  };
}

export const unparsableError = (
  name: string,
  unparsableQuery: string,
  format: string
) => ({
  status: 400,
  message: `Incorrect ${name} value format at '${name}=${unparsableQuery}'. Must be: ${name}=${format}`
});

export async function parseM3U8Text(res: Response): Promise<M3U> {
  /* [NOTE] 
   Function handles case for when Media Playlist doesn't have the '#EXT-X-PLAYLIST-TYPE:VOD' tag,
   but is still a vod since it has the #EXT-X-ENDLIST tag.
   We set PLAYLIST-TYPE here if that is the case to ensure,
   that 'm3u.toString()' will later return a m3u8 string with the endlist tag.
  */
  const parser = m3u8.createStream();
  res.body.pipe(parser);
  return new Promise((resolve, reject) => {
    parser.on('m3u', (m3u: M3U) => {
      resolve(m3u);
    });
    parser.on('error', (err) => {
      reject(err);
    });
  });
}

export function parseM3U8Stream(stream: ReadStream): Promise<M3U> {
  const parser = m3u8.createStream();
  stream.pipe(parser);
  return new Promise<M3U>((resolve, reject) => {
    parser.on('m3u', (m3u: M3U) => {
      resolve(m3u);
    });
    parser.on('error', (err) => {
      reject(err);
    });
  });
}

// @todo: Clarify what this function actually does
// Older comment: "This is needed because the internet is a bit broken..."
export function refineALBEventQuery(
  originalQuery: ALBEventQueryStringParameters
) {
  const queryStringParameters = clone(originalQuery);
  const searchParams = new URLSearchParams(
    Object.keys(queryStringParameters)
      .map((k) => `${k}=${queryStringParameters[k]}`)
      .join('&')
  );
  for (const k of searchParams.keys()) {
    queryStringParameters[k] = searchParams.get(k);
  }
  return queryStringParameters;
}

type ProxyBasenames =
  | 'proxy-media.m3u8'
  | '../../segments/proxy-segment'
  | 'proxy-segment/segment_$Number$.mp4';

/**
 * Adjust paths based on directory navigation
 * @param originPath ex. "http://abc.origin.com/streams/vod1/subfolder1/subfolder2"
 * @param uri ex. "../../subfolder3/media/segment.ts"
 * @returns ex. [ "http://abc.origin.com/streams/vod1", "subfolder3/media/segment.ts" ]
 */
const cleanUpPathAndURI = (originPath: string, uri: string): string[] => {
  const matchList: string[] | null = uri.match(/\.\.\//g);
  if (matchList) {
    const jumpsToParentDir = matchList.length;
    if (jumpsToParentDir > 0) {
      const splitPath = originPath.split('/');
      for (let i = 0; i < jumpsToParentDir; i++) {
        splitPath.pop();
      }
      originPath = splitPath.join('/');
      let str2split = '';
      for (let i = 0; i < jumpsToParentDir; i++) {
        str2split += '../';
      }
      uri = uri.split(str2split).pop();
    }
  }
  return [originPath, uri];
};

export function proxyPathBuilder(
  itemUri: string,
  urlSearchParams: URLSearchParams,
  proxy: ProxyBasenames
): string {
  if (!urlSearchParams) {
    return '';
  }
  //console.log("item URI : ", itemUri);
  const allQueries = new URLSearchParams(urlSearchParams);
  let sourceItemURL = '';
  // Do not build an absolute source url If ItemUri is already an absolut url.
  if (itemUri.match(/^http/)) {
    sourceItemURL = itemUri;
  } else {
    const sourceURL = allQueries.get('url');
    const baseURL: string = path.dirname(sourceURL);
    const [_baseURL, _itemUri] = cleanUpPathAndURI(baseURL, itemUri);
    //console.log("base URL : ", baseURL);

    sourceItemURL = `${_baseURL}/${_itemUri}`;
  }
  if (sourceItemURL) {
    allQueries.set('url', sourceItemURL);
  }
  const allQueriesString = allQueries.toString();
  //console.log('all queries : ', allQueries);
  return `${proxy}${allQueriesString ? `?${allQueriesString}` : ''}`;
}

export function segmentUrlParamString(
  sourceSegURL: string,
  configMap: CorruptorConfigMap
): string {
  let query = `url=${sourceSegURL}`;

  for (const name of configMap.keys()) {
    const fields = configMap.get(name).fields;
    const keys = Object.keys(fields);
    const corruptionInner = keys
      .map((key) => `${key}:${fields[key]}`)
      .join(',');
    const values = corruptionInner ? `{${corruptionInner}}` : '';
    query += `&${name}=${values}`;
  }
  return query;
}

export const SERVICE_ORIGIN =
  process.env.SERVICE_ORIGIN || 'http://localhost:8000';

export class AppSettings {
  static loadUrlParametersFromAwsSSM: boolean =
    process.env.LOAD_PARAMS_FROM_AWS_SSM === 'true';
}
