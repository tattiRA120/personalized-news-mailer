import { Logger } from '../logger';
import { XMLParser } from 'fast-xml-parser';
import { Env } from '../types/bindings';

export async function getRssImageUrl(rssFeedUrl: string, articleLink: string, env: Env): Promise<string | undefined> {
    const logger = new Logger(env);
    try {
        const response = await fetch(rssFeedUrl);
        if (!response.ok) {
            logger.error(`Failed to fetch RSS feed from ${rssFeedUrl}: ${response.statusText}`, null, { url: rssFeedUrl, status: response.status });
            return undefined;
        }
        const xml = await response.text();

        const options = {
            ignoreAttributes: false,
            attributeNamePrefix: "@_",
            cdataPropName: "__cdata",
            allowBooleanAttributes: true,
            parseTagValue: true,
            parseAttributeValue: true,
            trimValues: true,
        };
        const parser = new XMLParser(options);
        const jsonObj = parser.parse(xml);

        let imageUrl: string | undefined;

        // RSS 2.0 / 0.92 / 0.91
        if ((jsonObj as any).rss && (jsonObj as any).rss.channel) {
            const rssChannel = (jsonObj as any).rss.channel;
            const items = Array.isArray(rssChannel.item) ? rssChannel.item : (rssChannel.item ? [rssChannel.item] : []);
            const targetItem = items.find((item: any) => item.link === articleLink);

            if (targetItem) {
                if (targetItem['media:content'] && targetItem['media:content']['@_url']) {
                    imageUrl = targetItem['media:content']['@_url'];
                } else if (targetItem.enclosure && targetItem.enclosure['@_url'] && targetItem.enclosure['@_type'] && targetItem.enclosure['@_type'].startsWith('image/')) {
                    imageUrl = targetItem.enclosure['@_url'];
                } else if (targetItem.image && targetItem.image.url) {
                    imageUrl = targetItem.image.url;
                }
            }
        }
        // Atom 1.0
        else if ((jsonObj as any).feed && (jsonObj as any).feed.entry) {
            const atomFeed = (jsonObj as any).feed;
            const entries = Array.isArray(atomFeed.entry) ? atomFeed.entry : (atomFeed.entry ? [atomFeed.entry] : []);
            const targetEntry = entries.find((entry: any) => {
                let entryLink = '';
                if (entry.link) {
                    if (Array.isArray(entry.link)) {
                        const alternateLink = entry.link.find((l: any) => l['@_rel'] === 'alternate' && l['@_href']);
                        if (alternateLink) {
                            entryLink = alternateLink['@_href'];
                        }
                    } else if ((entry.link as any)['@_rel'] === 'alternate' && (entry.link as any)['@_href']) {
                        entryLink = (entry.link as any)['@_href'];
                    } else if ((entry.link as any)['@_href']) {
                        entryLink = (entry.link as any)['@_href'];
                    }
                }
                return entryLink === articleLink;
            });

            if (targetEntry) {
                if (targetEntry['media:content'] && targetEntry['media:content']['@_url']) {
                    imageUrl = targetEntry['media:content']['@_url'];
                } else if (targetEntry.link && Array.isArray(targetEntry.link)) {
                    const imageLink = targetEntry.link.find((l: any) => l['@_rel'] === 'enclosure' && l['@_type'] && l['@_type'].startsWith('image/') && l['@_href']);
                    if (imageLink) {
                        imageUrl = imageLink['@_href'];
                    }
                }
            }
        }
        // RSS 1.0 (RDF)
        else if ((jsonObj as any)['rdf:RDF'] && (jsonObj as any)['rdf:RDF'].item) {
            const rdfFeed = (jsonObj as any)['rdf:RDF'];
            const items = Array.isArray(rdfFeed.item) ? rdfFeed.item : (rdfFeed.item ? [rdfFeed.item] : []);
            const targetItem = items.find((item: any) => item.link === articleLink || item['@_rdf:about'] === articleLink);

            if (targetItem) {
                if (targetItem['media:content'] && targetItem['media:content']['@_url']) {
                    imageUrl = targetItem['media:content']['@_url'];
                } else if (targetItem.enclosure && targetItem.enclosure['@_url'] && targetItem.enclosure['@_type'] && targetItem.enclosure['@_type'].startsWith('image/')) {
                    imageUrl = targetItem.enclosure['@_url'];
                } else if (targetItem.image && targetItem.image.url) {
                    imageUrl = targetItem.image.url;
                }
            }
        }
        else {
            logger.info('Unknown feed format or no items/entries found for RSS image extraction.', { rssFeedUrl, articleLink });
        }

        if (imageUrl) {
            logger.info(`Found RSS image for ${articleLink} from ${rssFeedUrl}: ${imageUrl}`, { url: articleLink, rssFeedUrl, imageUrl });
        } else {
            logger.info(`No RSS image found for ${articleLink} from ${rssFeedUrl}.`, { url: articleLink, rssFeedUrl });
        }

        return imageUrl;

    } catch (error) {
        logger.error(`Error fetching or parsing RSS image for ${articleLink} from ${rssFeedUrl}:`, error, { url: articleLink, rssFeedUrl });
        return undefined;
    }
}
