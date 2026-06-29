import { useEffect, useState } from 'react'
import { api } from '../../api/client'

interface Props extends React.ImgHTMLAttributes<HTMLImageElement> {
  pid: string
  photoId: string
}

export function AuthImage({ pid, photoId, ...imgProps }: Props) {
  const [src, setSrc] = useState<string>()

  useEffect(() => {
    let url: string
    api.persons.fetchPhoto(pid, photoId).then(blobUrl => {
      url = blobUrl
      setSrc(blobUrl)
    }).catch(() => {})
    return () => { if (url) URL.revokeObjectURL(url) }
  }, [pid, photoId])

  return <img src={src} {...imgProps} />
}
