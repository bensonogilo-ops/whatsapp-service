import { downloadMediaMessage, proto } from '@whiskeysockets/baileys'
import { BOT_PASSWORD } from 'src/config/config'
import { bufferId, deepCopy, extractJidFromMessage, getCaptionAttribute } from 'src/util/baileys'
import Sticker, { StickerTypes } from 'wa-sticker-formatter'
import {
    ExtractStickerMediaData,
    ExtractViewOnceMediaData,
    ValueMessageMedia,
    WhatsappMessage,
    WhatsappMessageQuoted,
} from '../interface'

export class MediaMessage {
    private message: WhatsappMessage

    constructor(message: WhatsappMessage) {
        this.message = deepCopy(message)
    }

    static getMessageMedia(message: WhatsappMessage['message']): ValueMessageMedia {
        // Newer WhatsApp can send view once as a plain image/video with a viewOnce flag
        if (message?.imageMessage) {
            return { media: message.imageMessage, type: 'image', viewOnce: !!message.imageMessage.viewOnce }
        }
        if (message?.videoMessage) {
            return { media: message.videoMessage, type: 'video', viewOnce: !!message.videoMessage.viewOnce }
        }

        // Older formats wrap the media inside a view once container
        const wrapped: proto.IMessage | null | undefined =
            message?.viewOnceMessageV2?.message ||
            (message as any)?.viewOnceMessageV2Extension?.message ||
            message?.viewOnceMessage?.message

        if (wrapped?.imageMessage) {
            return { media: wrapped.imageMessage, type: 'image', viewOnce: true }
        }
        if (wrapped?.videoMessage) {
            return { media: wrapped.videoMessage, type: 'video', viewOnce: true }
        }

        return null
    }

    async extractStickerMedia(pack: string, author?: string): Promise<ExtractStickerMediaData> {
        if (!this.shouldConvertSticker()) {
            return null
        }

        const targetJid = extractJidFromMessage(this.message)
        if (!targetJid) {
            return null
        }

        const media = await downloadMediaMessage(this.message, 'buffer', {})

        const sticker = await this.convertSticker(media as Buffer, pack, author)
        if (!sticker) {
            return null
        }

        return { targetJid, message: { sticker } }
    }

    private async convertSticker(buffer: Buffer, pack: string, author?: string): Promise<Buffer> {
        const { type } = MediaMessage.getMessageMedia(this.message.message)

        const getQuality = () => {
            if (type === 'image') {
                return 50
            }
            if (buffer.length < 500 * 1024) {
                return 50
            }
            if (buffer.length < 1500 * 1024) {
                return 20
            }
            return 10
        }

        const sticker = new Sticker(buffer, {
            quality: getQuality(),
            type: StickerTypes.CROPPED,
            author,
            pack,
            id: bufferId(buffer),
        })

        const media = await sticker.toBuffer()
        if (type === 'image' || media.length < 1024 * 1000) {
            return media
        }

        return null
    }

    async extractViewOnceMedia(): Promise<ExtractViewOnceMediaData> {
        if (!this.shouldConvertViewOnceMedia()) {
            return null
        }

        const targetJid = extractJidFromMessage(this.message)
        if (!targetJid) {
            console.log('[debug] #dvo received but no reply chat id could be worked out')
            return null
        }

        // Shows whether the bot is replying to an @lid or a phone-number id
        console.log('[debug] #dvo target', targetJid, JSON.stringify(this.message.key))

        // Unwrap the view once container (if any) so we work on the plain media message
        const current: any = this.message?.message
        const wrapper = current?.viewOnceMessage || current?.viewOnceMessageV2 || current?.viewOnceMessageV2Extension
        const inner: any = wrapper?.message || current

        for (const key in inner) {
            const data = inner[key]
            if (data?.viewOnce) {
                data.viewOnce = false
            }
        }
        this.message.message = inner

        const info = MediaMessage.getMessageMedia(this.message.message)
        if (!info) {
            console.log('[debug] #dvo no image/video found after unwrapping')
            return null
        }

        // Download the decrypted bytes and send them as a brand new message,
        // instead of forwarding the original (which the phone can't unlock)
        let buffer: Buffer
        try {
            buffer = (await downloadMediaMessage(this.message, 'buffer', {})) as Buffer
        } catch (err) {
            console.log('[debug] #dvo download failed', err)
            return null
        }

        // Don't reuse the "#dvo" command text as the caption
        const originalCaption = info.media?.caption?.trim()
        const caption = originalCaption && !originalCaption.toLowerCase().startsWith('#dvo') ? originalCaption : undefined

        if (info.type === 'image') {
            return { targetJid, message: { image: buffer, caption } } as ExtractViewOnceMediaData
        }

        const video = info.media as proto.Message.IVideoMessage
        return {
            targetJid,
            message: { video: buffer, caption, mimetype: video?.mimetype || 'video/mp4' },
        } as ExtractViewOnceMediaData
    }

    private checkPassword(caption: string): boolean {
        if (!BOT_PASSWORD) return true

        return getCaptionAttribute(caption, 'password') === BOT_PASSWORD
    }

    private checkQuotedMessage() {
        const quoMessage = this.message?.message?.extendedTextMessage

        const media = MediaMessage.getMessageMedia(quoMessage?.contextInfo?.quotedMessage)
        if (!media) return

        const caption = quoMessage.text.trim()
        const destination = getCaptionAttribute(caption, 'destination')

        const quoted: WhatsappMessageQuoted = { message: caption }
        switch (destination.toLowerCase()) {
            case 'sender':
                quoted.sendToJid = quoMessage.contextInfo.participant
                break
            case 'me':
                quoted.sendToJid = this.message.key?.participant
                break
        }

        this.message.message = quoMessage.contextInfo.quotedMessage
        this.message.quoted = quoted
    }

    private shouldConvertSticker(): boolean {
        this.checkQuotedMessage()

        const stickerMedia = MediaMessage.getMessageMedia(this.message.message)

        if (stickerMedia?.viewOnce || (stickerMedia?.media as proto.Message.IVideoMessage)?.seconds > 10) {
            return false
        }

        const baseCaption = this.message?.quoted?.message || stickerMedia?.media?.caption
        const caption = baseCaption?.trim?.()
        if (
            !caption?.toLowerCase()?.startsWith('#convert_sticker') &&
            !caption?.toLowerCase()?.startsWith('#sticker')
        ) {
            return false
        }

        return this.checkPassword(caption)
    }

    private shouldConvertViewOnceMedia(): boolean {
        this.checkQuotedMessage()

        const viewOnceMedia = MediaMessage.getMessageMedia(this.message.message)

        const baseCaption = this.message?.quoted?.message || viewOnceMedia?.media?.caption
        const caption = baseCaption?.trim?.()
        if (!caption?.toLowerCase()?.startsWith('#dvo')) {
            return false
        }

        console.log(
            `[debug] #dvo received viewOnce=${!!viewOnceMedia?.viewOnce} type=${viewOnceMedia?.type ?? 'none'} keys=${Object.keys(this.message?.message || {}).join(',')}`,
        )

        if (!viewOnceMedia?.viewOnce) {
            return false
        }

        const passwordOk = this.checkPassword(caption)
        if (!passwordOk) {
            console.log('[debug] #dvo password mismatch')
        }
        return passwordOk
    }
}
